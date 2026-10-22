'use strict';

/**
 * Tests for issue #1803 — Stellar has deterministic finality (SCP), so the
 * ledger-count confirmation/finalization thresholds add latency without adding
 * safety.
 *
 * The proposal removes the depth-based states. These tests pin down the parts
 * of the state machine that the proposal keeps, and record the remaining
 * acceptance criteria as todos until the simplification lands.
 *
 * Acceptance criteria (from the issue):
 *  1. A successful payment is credited, receipted and reported in the same
 *     processing step that detects it.                               → todo
 *  2. Keep one review dimension: isSuspicious / UNDER_REVIEW short-circuits
 *     to FAILED regardless of ledger depth.                          → tested
 *  3. The confirmation-threshold code and the finalizer are removed or
 *     reduced to a documented no-op.                                 → todo
 */

const {
  CONFIRMATION_STATES,
  computeTargetState,
  resolveNextState,
  deriveLegacyConfirmationStatus,
} = require("../backend/src/services/paymentConfirmationStateMachine");

const THRESHOLDS = { confirmationThreshold: 2, finalizationThreshold: 10 };

describe("issue #1803 — suspicious payments stay under review regardless of depth", () => {
  it.each([
    ["at the tip (depth 0)", 1000, 1000],
    ["one ledger deep", 1000, 1001],
    ["past the finalization threshold", 1000, 1500],
  ])("isSuspicious forces FAILED when %s", (_label, txLedger, latest) => {
    const target = computeTargetState({
      txLedger,
      latestLedgerSequence: latest,
      isSuspicious: true,
      ...THRESHOLDS,
    });
    expect(target).toBe(CONFIRMATION_STATES.FAILED);
  });

  it("escapes to FAILED from a non-terminal state even when depth would confirm", () => {
    const { state, changed } = resolveNextState(
      CONFIRMATION_STATES.DETECTED,
      CONFIRMATION_STATES.FAILED
    );
    expect(state).toBe(CONFIRMATION_STATES.FAILED);
    expect(changed).toBe(true);
  });

  it("maps FAILED onto the legacy 'failed' status", () => {
    expect(deriveLegacyConfirmationStatus(CONFIRMATION_STATES.FAILED)).toBe("failed");
  });
});

describe("issue #1803 — current depth thresholds (to be removed)", () => {
  it("a payment at the ledger tip is DETECTED, not confirmed", () => {
    // Documents the cost the issue describes: a payment in a closed ledger has
    // to wait for extra ledgers before it reads as confirmed.
    const atTip = computeTargetState({
      txLedger: 1000,
      latestLedgerSequence: 1000,
      ...THRESHOLDS,
    });
    expect(atTip).toBe(CONFIRMATION_STATES.DETECTED);
  });
});

describe("issue #1803 — pending work", () => {
  it.todo("records a successful closed-ledger payment as SUCCESS in one processing step");
  it.todo("credits and receipts a successful payment without a separate finalizer pass");
  it.todo("removes CONFIRMATION_THRESHOLD and FINALIZATION_THRESHOLD from config");
  it.todo("documents SCP finality in docs/stellar-integration.md");
});
