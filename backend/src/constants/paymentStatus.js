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
 * Horizon transaction result codes that represent a *definitive* failure —
 * the transaction was rejected by the network and can never be applied.
 *
 * Anything not listed here (e.g. `tx_too_late` before time bounds expire,
 * `tx_insufficient_fee` under surge pricing, or a bare 504/5xx/network error)
 * is treated as *ambiguous*: the transaction may still be included in a
 * ledger, so the payment must remain SUBMITTED and be resolved by hash.
 *
 * Issue #1562.
 */
const DEFINITIVE_TX_RESULT_CODES = Object.freeze([
  'tx_bad_seq',
  'tx_bad_auth',
  'tx_bad_auth_extra',
  'tx_insufficient_balance',
  'tx_insufficient_fee',
  'tx_no_source_account',
  'tx_no_account',
  'tx_not_supported',
  'tx_malformed',
  'tx_bad_minseq_age',
  'tx_source_account_not_found',
  'op_no_trust',
  'op_underfunded',
  'op_no_destination',
  'op_not_authorized',
  'op_malformed',
  'op_already_exists',
  'op_src_no_trust',
  'op_src_not_authorized',
  'op_no_issuer',
  'op_low_reserve',
  'op_line_full',
  'op_cross_self',
  'op_sell_no_trust',
  'op_buy_no_trust',
  'op_not_found',
  'op_invalid_asset',
  'op_asset_not_authorized',
  'op_does_not_exist',
  'op_too_many_subentries',
  'op_too_many_signers',
  'op_bad_auth',
  'op_no_source_account',
  'op_src_no_trust',
  'op_src_underfunded',
  'op_src_low_reserve',
  'op_src_not_authorized',
  'op_src_malformed',
  'op_src_no_issuer',
  'op_src_line_full',
  'op_src_cross_self',
  'op_src_sell_no_trust',
  'op_src_buy_no_trust',
  'op_src_not_found',
  'op_src_invalid_asset',
  'op_src_asset_not_authorized',
  'op_src_does_not_exist',
  'op_src_too_many_subentries',
  'op_src_too_many_signers',
  'op_src_bad_auth',
  'op_src_no_source_account',
]);

/**
 * Returns true when a Horizon transaction result code is a definitive
 * failure (the transaction can never be applied). Ambiguous codes — and
 * anything not in the list — return false so callers keep the payment
 * SUBMITTED and resolve it by hash. Issue #1562.
 *
 * @param {string} [code]
 * @returns {boolean}
 */
function isDefinitiveTxResultCode(code) {
  if (!code || typeof code !== 'string') return false;
  return DEFINITIVE_TX_RESULT_CODES.includes(code);
}

module.exports = {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  isTransitionAllowed,
  DEFINITIVE_TX_RESULT_CODES,
  isDefinitiveTxResultCode,
};
