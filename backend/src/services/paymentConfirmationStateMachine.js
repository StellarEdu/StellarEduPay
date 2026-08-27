"use strict";

/**
 * Payment confirmation finality policy (issue #747).
 *
 * On-chain payments move through five explicit, ranked states. The state
 * machine is pure (no I/O, no DB/Horizon access) so it can be unit tested in
 * isolation; callers are responsible for fetching the latest ledger sequence
 * and persisting the result.
 *
 *   detected  → tx observed on Horizon; ledger known but 0 ledgers have
 *               closed since (depth 0). Earliest possible state.
 *   pending   → 1..(CONFIRMATION_THRESHOLD-1) ledgers have closed since the
 *               tx's ledger. Awaiting enough depth to be considered safe
 *               against a typical Horizon failover/replay.
 *   confirmed → depth >= CONFIRMATION_THRESHOLD ledgers. Safe to treat the
 *               payment as real for balance/UI purposes.
 *   finalized → depth >= FINALIZATION_THRESHOLD ledgers (> CONFIRMATION_
 *               THRESHOLD). Practically irreversible; no further manual
 *               correction should ever be needed.
 *   failed    → flagged suspicious (memo collision / abnormal pattern) or
 *               otherwise invalid. Terminal.
 *
 * Transitions are monotonic and idempotent by construction:
 *   - finalized and failed are terminal — no outgoing transitions.
 *   - re-computing a target state that ranks at or below the current state
 *     is a no-op (re-polling the same or an overlapping ledger range never
 *     regresses or incorrectly re-advances a payment).
 *   - forward jumps that skip intermediate states are allowed (e.g. a
 *     payment can be first observed already past CONFIRMATION_THRESHOLD and
 *     go straight from detected to confirmed).
 *   - failed is reachable from any non-terminal state.
 *
 * See the state diagram in docs/architecture.md (Payment Confirmation State
 * Machine section) for a visual reference of the transitions below.
 */

const CONFIRMATION_STATES = Object.freeze({
  DETECTED: "detected",
  PENDING: "pending",
  CONFIRMED: "confirmed",
  FINALIZED: "finalized",
  FAILED: "failed",
});

const STATE_RANK = Object.freeze({
  [CONFIRMATION_STATES.DETECTED]: 0,
  [CONFIRMATION_STATES.PENDING]: 1,
  [CONFIRMATION_STATES.CONFIRMED]: 2,
  [CONFIRMATION_STATES.FINALIZED]: 3,
  [CONFIRMATION_STATES.FAILED]: 99,
});

const TERMINAL_STATES = new Set([
  CONFIRMATION_STATES.FINALIZED,
  CONFIRMATION_STATES.FAILED,
]);

// Documented, explicit transition table — the single source of truth for
// which jumps are legal. Kept in sync with the monotonic rank rule in
// resolveNextState (rank enforces "never go backwards"; this table documents
// and enforces "which forward jumps are meaningful").
const CONFIRMATION_STATE_TRANSITIONS = Object.freeze({
  // detected: earliest observation. May advance one step at a time (pending),
  // fast-forward straight to confirmed/finalized if first observed already
  // deep in the ledger, or escape to failed on a fraud/anomaly signal.
  [CONFIRMATION_STATES.DETECTED]: [
    CONFIRMATION_STATES.PENDING,
    CONFIRMATION_STATES.CONFIRMED,
    CONFIRMATION_STATES.FINALIZED,
    CONFIRMATION_STATES.FAILED,
  ],
  // pending: not yet safe for balance/UI purposes. Can reach confirmed once
  // depth clears the threshold, skip straight to finalized on a slow poll
  // cycle, or be flagged failed at any point before it is trusted.
  [CONFIRMATION_STATES.PENDING]: [
    CONFIRMATION_STATES.CONFIRMED,
    CONFIRMATION_STATES.FINALIZED,
    CONFIRMATION_STATES.FAILED,
  ],
  // confirmed: already treated as real money. Only remaining moves are
  // becoming irreversible (finalized) or being retroactively flagged failed
  // (e.g. a fraud signal detected after initial confirmation).
  [CONFIRMATION_STATES.CONFIRMED]: [
    CONFIRMATION_STATES.FINALIZED,
    CONFIRMATION_STATES.FAILED,
  ],
  // finalized: practically irreversible — no further manual correction
  // should ever be needed, so no outgoing transitions.
  [CONFIRMATION_STATES.FINALIZED]: [],
  // failed: terminal escape hatch — once flagged invalid/suspicious, a
  // payment never re-enters the confirmation pipeline.
  [CONFIRMATION_STATES.FAILED]: [],
});

/**
 * Compute the state a payment *should* be in given fresh ledger info, with
 * no knowledge of where it currently is. Pure function of its inputs — the
 * same (txLedger, latestLedgerSequence, isSuspicious) always yields the same
 * target, which is what makes re-polling idempotent.
 *
 * @param {object} params
 * @param {number|null} params.txLedger - ledger sequence the tx was included in
 * @param {number|null} params.latestLedgerSequence - latest known Horizon ledger sequence
 * @param {boolean} [params.isSuspicious] - fraud/anomaly signal short-circuits to FAILED
 * @param {number} params.confirmationThreshold - ledgers required for CONFIRMED
 * @param {number} params.finalizationThreshold - ledgers required for FINALIZED
 * @returns {string} one of CONFIRMATION_STATES
 */
function computeTargetState({
  txLedger,
  latestLedgerSequence,
  isSuspicious = false,
  confirmationThreshold,
  finalizationThreshold,
}) {
  if (isSuspicious) return CONFIRMATION_STATES.FAILED;

  if (!txLedger || !latestLedgerSequence) {
    return CONFIRMATION_STATES.DETECTED;
  }

  const depth = latestLedgerSequence - txLedger;

  if (depth >= finalizationThreshold) return CONFIRMATION_STATES.FINALIZED;
  if (depth >= confirmationThreshold) return CONFIRMATION_STATES.CONFIRMED;
  if (depth >= 1) return CONFIRMATION_STATES.PENDING;
  return CONFIRMATION_STATES.DETECTED;
}

/**
 * Resolve the next persisted state given the current state and a freshly
 * computed target. This is the idempotency/monotonicity guarantee:
 *   - terminal current states never move.
 *   - a target that doesn't outrank the current state is a no-op (covers
 *     re-polling the same ledger range, or a stale/lagging Horizon replica
 *     momentarily reporting a lower ledger).
 *   - otherwise the jump must be a documented transition.
 *
 * @param {string|null|undefined} currentState
 * @param {string} targetState
 * @returns {{ state: string, changed: boolean }}
 */
function resolveNextState(currentState, targetState) {
  if (!Object.prototype.hasOwnProperty.call(STATE_RANK, targetState)) {
    throw new Error(`Unknown confirmation state: ${targetState}`);
  }

  const current = currentState && STATE_RANK.hasOwnProperty(currentState)
    ? currentState
    : CONFIRMATION_STATES.DETECTED;

  if (TERMINAL_STATES.has(current)) {
    return { state: current, changed: false };
  }

  // Idempotent no-op: target doesn't outrank current (covers same-state
  // re-poll and any stale/regressed recompute), unless it's an escape to
  // FAILED, which is always allowed to take effect from a non-terminal state.
  if (
    STATE_RANK[targetState] <= STATE_RANK[current] &&
    targetState !== CONFIRMATION_STATES.FAILED
  ) {
    return { state: current, changed: false };
  }

  const allowed = CONFIRMATION_STATE_TRANSITIONS[current] || [];
  if (!allowed.includes(targetState)) {
    return { state: current, changed: false };
  }

  return { state: targetState, changed: true };
}

/**
 * Map a fine-grained confirmation state onto the legacy 3-value
 * Payment.confirmationStatus field, so existing consumers (admin "pending
 * payments" queries, balance-update gates, receipt emails) keep working
 * unchanged: detected/pending → pending_confirmation, confirmed/finalized →
 * confirmed, failed → failed.
 *
 * @param {string} state
 * @returns {'pending_confirmation'|'confirmed'|'failed'}
 */
function deriveLegacyConfirmationStatus(state) {
  if (state === CONFIRMATION_STATES.FAILED) return "failed";
  if (
    state === CONFIRMATION_STATES.CONFIRMED ||
    state === CONFIRMATION_STATES.FINALIZED
  ) {
    return "confirmed";
  }
  return "pending_confirmation";
}

/**
 * True once a state has reached at least CONFIRMED rank (confirmed or
 * finalized) — the threshold at which the rest of the app treats a payment
 * as real money received.
 *
 * @param {string} state
 * @returns {boolean}
 */
function isConfirmedOrAbove(state) {
  return STATE_RANK[state] >= STATE_RANK[CONFIRMATION_STATES.CONFIRMED];
}

module.exports = {
  CONFIRMATION_STATES,
  STATE_RANK,
  TERMINAL_STATES,
  CONFIRMATION_STATE_TRANSITIONS,
  computeTargetState,
  resolveNextState,
  deriveLegacyConfirmationStatus,
  isConfirmedOrAbove,
};
