'use strict';

/**
 * Canonical payment status definitions — Issue #72.
 *
 * This is the single source of truth for payment statuses and their allowed
 * transitions. Import this module everywhere a status value is needed:
 *
 *   const { PAYMENT_STATUS, PAYMENT_STATUS_TRANSITIONS, ADMIN_PAYMENT_STATUS_TRANSITIONS }
 *     = require('../constants/paymentStatus');
 *
 * Never use inline string literals for payment statuses. This prevents drift
 * between the model's allowed set, controller checks, and any future tooling.
 *
 * ---------------------------------------------------------------------------
 * Authoritative lifecycle — Issue #1560
 * ---------------------------------------------------------------------------
 * `status` is the ONE authoritative, persisted lifecycle field. The other
 * fields that historically overlapped with it are derived from `status` and
 * must never be treated as independent sources of truth:
 *
 *   status            — authoritative (persisted).
 *   confirmationStatus — derived: 'confirmed' for SUCCESS/REFUNDED,
 *                        'failed' for FAILED/INVALID, otherwise
 *                        'pending_confirmation'.
 *   confirmationState  — derived: mirrors the confirmationStatus mapping
 *                        (see paymentConfirmationStateMachine.js).
 *
 * Use `deriveConfirmationStatus(status)` / `deriveConfirmationState(status)`
 * to compute the derived fields, and `isCountedAsPaid(status)` as the single
 * shared predicate for "counted as paid" across reports, summaries and
 * finalisation logic. A migration to drop the redundant fields is a follow-up
 * (see issue #1560 acceptance criteria); this module only documents and
 * centralises the derivation so all callers agree.
 */

/**
 * All valid payment status values.
 *
 * PENDING        — Payment detected on-chain, awaiting confirmation.
 * SUBMITTED      — Payment has been submitted for processing.
 * SUCCESS        — Payment confirmed and matched to a student.
 * FAILED         — Payment failed (bad destination, wrong asset, etc.).
 * DISPUTED       — Payment marked as disputed by an admin or parent.
 * REFUND_PENDING — A refund has been initiated and is awaiting approval/execution.
 * REFUNDED       — Payment has been fully or partially refunded and confirmed on-chain.
 * INVALID        — Payment is structurally invalid (missing memo, etc.).
 */
const PAYMENT_STATUS = Object.freeze({
  PENDING:        'PENDING',
  SUBMITTED:      'SUBMITTED',
  SUCCESS:        'SUCCESS',
  FAILED:         'FAILED',
  DISPUTED:       'DISPUTED',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED:       'REFUNDED',
  INVALID:        'INVALID',
});

/**
 * Array of all valid status strings (for Mongoose enum validation).
 */
const PAYMENT_STATUS_VALUES = Object.freeze(Object.values(PAYMENT_STATUS));

/**
 * Allowed status transitions for normal (non-admin) paths.
 *
 *   SUCCESS        → DISPUTED       : admin marks a confirmed payment as disputed
 *   SUCCESS        → REFUND_PENDING : admin initiates a refund request
 *   REFUND_PENDING → REFUNDED       : refund confirmed on-chain
 *   REFUND_PENDING → SUCCESS        : refund rejected, payment restored to SUCCESS
 *   PENDING        → FAILED         : admin manually fails a stuck pending payment
 *   SUBMITTED      → FAILED         : admin manually fails a stuck submitted payment
 *
 * All other transitions are rejected. Callers with admin authority can use
 * ADMIN_PAYMENT_STATUS_TRANSITIONS (see below) after setting
 * payment.$locals.adminOverride = true.
 */
const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.SUCCESS]:        [PAYMENT_STATUS.DISPUTED, PAYMENT_STATUS.REFUND_PENDING],
  [PAYMENT_STATUS.REFUND_PENDING]: [PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.SUCCESS],
  [PAYMENT_STATUS.PENDING]:        [PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUBMITTED]:      [PAYMENT_STATUS.FAILED],
});

/**
 * Additional transitions available only when adminOverride = true.
 * These paths must be explicitly audited by the caller.
 *
 *   SUCCESS        → REFUND_PENDING : admin initiates a refund
 *   SUCCESS        → REFUNDED       : admin directly refunds (legacy / manual)
 *   REFUND_PENDING → REFUNDED       : refund confirmed on-chain
 *   REFUND_PENDING → SUCCESS        : refund rejected, restores SUCCESS
 *   DISPUTED       → REFUNDED       : admin resolves a dispute via refund
 *   FAILED         → SUCCESS        : admin corrects a payment wrongly marked failed
 *                                     (e.g. a submission that actually succeeded, a sync
 *                                     race, a misclassified permanent-failure code) once
 *                                     manual reconciliation confirms funds arrived —
 *                                     Issue #1029
 *   FAILED         → DISPUTED       : admin escalates a wrongly-failed payment for
 *                                     investigation rather than confirming it outright —
 *                                     Issue #1029
 */
const ADMIN_PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.SUCCESS]:        [PAYMENT_STATUS.DISPUTED, PAYMENT_STATUS.REFUND_PENDING, PAYMENT_STATUS.REFUNDED],
  [PAYMENT_STATUS.REFUND_PENDING]: [PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.SUCCESS],
  [PAYMENT_STATUS.PENDING]:        [PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUBMITTED]:      [PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.DISPUTED]:       [PAYMENT_STATUS.REFUNDED],
  [PAYMENT_STATUS.FAILED]:         [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.DISPUTED],
});

/**
 * Returns true when a status transition is allowed for the given path.
 *
 * @param {string} from - Current status
 * @param {string} to   - Desired next status
 * @param {boolean} [adminOverride=false] - Use admin transition table
 * @returns {boolean}
 */
function isTransitionAllowed(from, to, adminOverride = false) {
  const table = adminOverride
    ? ADMIN_PAYMENT_STATUS_TRANSITIONS
    : PAYMENT_STATUS_TRANSITIONS;
  const allowed = table[from] || [];
  return allowed.includes(to);
}

/**
 * Statuses that represent money that has actually been received and should be
 * counted as "paid" by reports, summaries and finalisation logic.
 *
 * REFUNDED is intentionally excluded: the funds were returned, so the payment
 * no longer contributes to paid totals. DISPUTED is excluded because the
 * payment is under investigation. This is the single shared predicate — do not
 * re-implement `status === 'SUCCESS'` checks elsewhere (Issue #1560).
 */
const COUNTED_AS_PAID_STATUSES = Object.freeze([
  PAYMENT_STATUS.SUCCESS,
]);

/**
 * Single shared predicate for "counted as paid".
 *
 * @param {string} status - A PAYMENT_STATUS value
 * @returns {boolean}
 */
function isCountedAsPaid(status) {
  return COUNTED_AS_PAID_STATUSES.includes(status);
}

/**
 * Derives the legacy `confirmationStatus` value from the authoritative
 * `status`. Kept in sync with the model's confirmationStatus enum
 * (`pending_confirmation | confirmed | failed`).
 *
 * @param {string} status - A PAYMENT_STATUS value
 * @returns {'confirmed'|'failed'|'pending_confirmation'}
 */
function deriveConfirmationStatus(status) {
  if (status === PAYMENT_STATUS.SUCCESS || status === PAYMENT_STATUS.REFUNDED) {
    return 'confirmed';
  }
  if (status === PAYMENT_STATUS.FAILED || status === PAYMENT_STATUS.INVALID) {
    return 'failed';
  }
  return 'pending_confirmation';
}

/**
 * Derives the legacy `confirmationState` value from the authoritative
 * `status`. Mirrors `deriveConfirmationStatus` so the state machine and the
 * model agree on a single lifecycle (Issue #1560).
 *
 * @param {string} status - A PAYMENT_STATUS value
 * @returns {'confirmed'|'failed'|'pending_confirmation'}
 */
function deriveConfirmationState(status) {
  return deriveConfirmationStatus(status);
}

module.exports = {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  COUNTED_AS_PAID_STATUSES,
  isTransitionAllowed,
  isCountedAsPaid,
  deriveConfirmationStatus,
  deriveConfirmationState,
};
