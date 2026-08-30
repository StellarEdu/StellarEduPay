import i18n from "../i18n";

/**
 * Canonical payment status definitions for the frontend — Issue #72.
 *
 * These values mirror the backend API contract defined in
 * backend/src/constants/paymentStatus.js. Use these constants when
 * comparing or displaying payment.status values from API responses
 * instead of inline string literals.
 *
 * NOTE: Student fee status (paid / partial / unpaid) is a separate concept
 * computed from payment history. It lives in the student model and is NOT
 * the same as payment.status.
 */

export const PAYMENT_STATUS = Object.freeze({
  PENDING:   'PENDING',
  SUBMITTED: 'SUBMITTED',
  SUCCESS:   'SUCCESS',
  FAILED:    'FAILED',
  DISPUTED:  'DISPUTED',
  REFUNDED:  'REFUNDED',
  INVALID:   'INVALID',
});

/**
 * Human-readable labels for each payment status.
 * Suitable for display in tables, badges, and tooltips.
 */
export const PAYMENT_STATUS_LABELS = Object.freeze({
  [PAYMENT_STATUS.PENDING]:   'Pending',
  [PAYMENT_STATUS.SUBMITTED]: 'Submitted',
  [PAYMENT_STATUS.SUCCESS]:   'Success',
  [PAYMENT_STATUS.FAILED]:    'Failed',
  [PAYMENT_STATUS.DISPUTED]:  'Disputed',
  [PAYMENT_STATUS.REFUNDED]:  'Refunded',
  [PAYMENT_STATUS.INVALID]:   'Invalid',
});

/**
 * Terminal statuses — payments in these states will not change further.
 */
export const TERMINAL_STATUSES = Object.freeze([
  PAYMENT_STATUS.SUCCESS,
  PAYMENT_STATUS.FAILED,
  PAYMENT_STATUS.REFUNDED,
  PAYMENT_STATUS.INVALID,
]);

/**
 * Returns the display label for a payment status, with a fallback for
 * unknown values. Localized via i18n (status.payment.<STATUS>); falls back
 * to the English label map for anything not translated.
 *
 * @param {string} status
 * @returns {string}
 */
export function getPaymentStatusLabel(status) {
  if (status && PAYMENT_STATUS_LABELS[status]) {
    const key = `status.payment.${status}`;
    const resolved = i18n.t(key);
    if (typeof resolved === "string" && resolved !== key) return resolved;
    return PAYMENT_STATUS_LABELS[status];
  }
  return status ?? 'Unknown';
}

/**
 * Returns true if the given status is terminal (will not change).
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}
