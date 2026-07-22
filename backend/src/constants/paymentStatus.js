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
 */

/**
 * All valid payment status values.
 *
 * PENDING   — Payment detected on-chain, awaiting confirmation.
 * SUBMITTED — Payment has been submitted for processing.
 * SUCCESS   — Payment confirmed and matched to a student.
 * FAILED    — Payment failed (bad destination, wrong asset, etc.).
 * DISPUTED  — Payment marked as disputed by an admin or parent.
 * REFUNDED  — Payment has been refunded.
 * INVALID   — Payment is structurally invalid (missing memo, etc.).
 */
const PAYMENT_STATUS = Object.freeze({
  PENDING:   'PENDING',
  SUBMITTED: 'SUBMITTED',
  SUCCESS:   'SUCCESS',
  FAILED:    'FAILED',
  DISPUTED:  'DISPUTED',
  REFUNDED:  'REFUNDED',
  INVALID:   'INVALID',
});

/**
 * Array of all valid status strings (for Mongoose enum validation).
 */
const PAYMENT_STATUS_VALUES = Object.freeze(Object.values(PAYMENT_STATUS));

/**
 * Allowed status transitions for normal (non-admin) paths.
 *
 *   SUCCESS   → DISPUTED  : admin marks a confirmed payment as disputed
 *   SUCCESS   → REFUNDED  : admin marks a confirmed payment as refunded
 *   PENDING   → FAILED    : admin manually fails a stuck pending payment
 *   SUBMITTED → FAILED    : admin manually fails a stuck submitted payment
 *
 * All other transitions are rejected. Callers with admin authority can use
 * ADMIN_PAYMENT_STATUS_TRANSITIONS (see below) after setting
 * payment.$locals.adminOverride = true.
 */
const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.SUCCESS]:   [PAYMENT_STATUS.DISPUTED, PAYMENT_STATUS.REFUNDED],
  [PAYMENT_STATUS.PENDING]:   [PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUBMITTED]: [PAYMENT_STATUS.FAILED],
});

/**
 * Additional transitions available only when adminOverride = true.
 * These paths must be explicitly audited by the caller.
 *
 *   SUCCESS  → REFUNDED  : admin refunds a confirmed payment
 *   DISPUTED → REFUNDED  : admin (or dispute resolution) refunds a disputed payment
 *   DISPUTED → SUCCESS   : admin (or dispute resolution) rejects a dispute, restoring
 *                          the original confirmed status
 */
const ADMIN_PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.SUCCESS]:   [PAYMENT_STATUS.DISPUTED, PAYMENT_STATUS.REFUNDED],
  [PAYMENT_STATUS.PENDING]:   [PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUBMITTED]: [PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.DISPUTED]:  [PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.SUCCESS],
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

module.exports = {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  isTransitionAllowed,
};
