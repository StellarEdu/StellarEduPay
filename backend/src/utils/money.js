'use strict';

// @ts-check

/**
 * Canonical money helper for the payment-verification path (#1123 follow-up).
 *
 * paymentController.verifyPayment decided whether a student's fee was settled
 * using IEEE-754 doubles: it summed prior payments with MongoDB's `$sum`
 * (float addition, done server-side, order not guaranteed), rounded with
 * `toFixed(7)`, re-parsed with `parseFloat`, and compared the result to
 * `feeAmount` with `===`/`<`/`>`. toFixed cannot repair a value already
 * corrupted by float addition, and parseFloat immediately turns the rounded
 * string back into a double — reintroducing the same class of error on the
 * very next operation. A fee paid in instalments that sum, in exact decimal,
 * to precisely the fee amount could therefore be classified 'partial' or
 * 'overpaid' instead of 'valid'.
 *
 * This module makes decimal.js (already the convention in
 * paymentLimitsService.js, currencyConversionService.js,
 * feeAdjustmentEngine.js and utils/paymentLimits.js — see their "ROUNDING
 * POLICY" comments) the single representation for this path too. Amounts are
 * parsed into Decimal, compared and summed exactly, and converted to a JS
 * Number only at the API/DB-write boundary via toMoneyNumber().
 *
 * The MongoDB side of the same bug — `{ $sum: '$amount' }` accumulates BSON
 * doubles — is fixed by summing `{ $toDecimal: '$amount' }` instead, so the
 * addition happens in exact Decimal128 space inside MongoDB itself. Feed the
 * aggregate's result through decimalFromMongo() to get a decimal.js Decimal
 * back out.
 */

const Decimal = require('decimal.js');

// XLM and USDC both carry exactly 7 decimal places on Stellar.
const MONEY_DECIMALS = 7;
const ROUNDING = Decimal.ROUND_HALF_UP;

/**
 * @typedef {import('decimal.js').Decimal} DecimalValue
 * @typedef {DecimalValue|number|string} MoneyInput
 */

/**
 * Reject values that cannot be interpreted as a monetary amount. Passing an
 * options object (or `undefined`) where a number was expected used to be
 * silently coerced to 0, which made every payment look 'overpaid' (#1969).
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {void}
 */
function assertMoneyInput(value, label = 'value') {
  if (value === undefined) {
    throw new TypeError(`toMoney: ${label} is undefined (expected a number, numeric string or Decimal)`);
  }
  if (value === null) {
    throw new TypeError(`toMoney: ${label} is null (expected a number, numeric string or Decimal)`);
  }
  if (typeof value === 'object' && !(value instanceof Decimal)) {
    throw new TypeError(
      `toMoney: ${label} is a plain object (expected a number, numeric string or Decimal)`
    );
  }
  if (typeof value === 'boolean') {
    throw new TypeError(`toMoney: ${label} is a boolean (expected a number, numeric string or Decimal)`);
  }
}

/**
 * Parse any monetary value (Number, numeric string, Decimal) into a Decimal.
 * Throws a TypeError on `undefined`, `null` and plain objects so that a
 * mis-shaped call fails loudly instead of classifying against a fee of 0.
 *
 * @param {MoneyInput} value
 * @returns {DecimalValue}
 */
function toMoney(value) {
  if (value instanceof Decimal) return value;
  assertMoneyInput(value);
  if (value === '') return new Decimal(0);
  return new Decimal(/** @type {number|string} */ (value));
}

/**
 * A Mongo aggregate field produced via `{ $sum: { $toDecimal: '$field' } }`
 * comes back as a BSON Decimal128. Decimal128#toString() is exact, so it is
 * safe to feed straight into decimal.js.
 *
 * @param {unknown} value
 * @returns {DecimalValue}
 */
function decimalFromMongo(value) {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === 'object') {
    const str = String(value);
    return new Decimal(str);
  }
  return new Decimal(/** @type {number|string} */ (value));
}

/**
 * Round to Stellar's 7 decimal places, half-up. Returns a Decimal.
 *
 * @param {MoneyInput} value
 * @returns {DecimalValue}
 */
function roundMoney(value) {
  return toMoney(value).toDecimalPlaces(MONEY_DECIMALS, ROUNDING);
}

/**
 * Round to 7dp and convert to a plain JS Number — use only at the output boundary.
 *
 * @param {MoneyInput} value
 * @returns {number}
 */
function toMoneyNumber(value) {
  return roundMoney(value).toNumber();
}

/**
 * -1 / 0 / 1, exact — never affected by float epsilon.
 *
 * @param {MoneyInput} a
 * @param {MoneyInput} b
 * @returns {-1|0|1}
 */
function compareMoney(a, b) {
  return /** @type {-1|0|1} */ (toMoney(a).cmp(toMoney(b)));
}

/**
 * @param {MoneyInput} a
 * @param {MoneyInput} b
 * @returns {boolean}
 */
function moneyEquals(a, b) {
  return compareMoney(a, b) === 0;
}

/**
 * @typedef {Object} FeeClassification
 * @property {'partial'|'underpaid'|'valid'|'overpaid'} status
 * @property {boolean} feePaid
 * @property {number} cumulativeTotal
 * @property {number} excessAmount
 * @property {number} remainingBalance
 */

/**
 * Classify a student's cumulative payment total against their fee, and derive
 * excessAmount / remainingBalance — all in exact Decimal space. Replaces the
 * `parseFloat(x.toFixed(7))` + `<`/`>`/`===` logic that used to live inline in
 * paymentController.verifyPayment and utils/studentBalanceUpdater.
 *
 * @param {MoneyInput} cumulativeTotal - total successfully paid so far
 * @param {MoneyInput} feeAmount - the fee owed
 * @returns {FeeClassification}
 */
function classifyFeePayment(cumulativeTotal, feeAmount) {
  const cumulative = roundMoney(cumulativeTotal);
  const fee = toMoney(feeAmount);
  const cmp = cumulative.cmp(fee);

  /** @type {'partial'|'valid'|'overpaid'} */
  let status;
  if (cmp < 0) status = 'partial';
  else if (cmp > 0) status = 'overpaid';
  else status = 'valid';

  return {
    status,
    feePaid: cmp >= 0,
    cumulativeTotal: cumulative.toNumber(),
    excessAmount: status === 'overpaid' ? toMoneyNumber(cumulative.minus(fee)) : 0,
    remainingBalance: toMoneyNumber(Decimal.max(0, fee.minus(cumulative))),
  };
}

/**
 * @typedef {Object} ClassifyFeePaymentOptions
 * @property {MoneyInput|null} [installmentAmount]
 */

/**
 * The single canonical entry point every writer of
 * `Payment.feeValidationStatus` must use (#1766).
 *
 * Vocabulary (see docs/payment-plans-underpaid-reconciliation.md):
 *   - 'partial'   — cumulative total is below the fee; the payment is accepted
 *                   as an instalment toward the fee.
 *   - 'underpaid' — an active payment plan exists and the cumulative total has
 *                   not yet met the expected installment amount (#1379).
 *   - 'valid' / 'overpaid' — cumulative total equals / exceeds the fee.
 *
 * When no installmentAmount is supplied (no active plan) this delegates
 * straight to classifyFeePayment, so 'underpaid' is never produced without a
 * plan. All other fields come from classifyFeePayment unchanged.
 *
 * @param {MoneyInput} cumulativeTotal - total successfully paid so far
 * @param {MoneyInput} feeAmount - the fee owed
 * @param {ClassifyFeePaymentOptions} [options]
 * @returns {FeeClassification}
 */
function classifyFeePaymentStatus(cumulativeTotal, feeAmount, options = {}) {
  const result = classifyFeePayment(cumulativeTotal, feeAmount);
  const { installmentAmount } = options || {};

  if (
    result.status === 'partial' &&
    installmentAmount !== null &&
    installmentAmount !== undefined &&
    installmentAmount !== ''
  ) {
    const cumulative = roundMoney(cumulativeTotal);
    const expected = roundMoney(installmentAmount);
    if (cumulative.cmp(expected) < 0) {
      return { ...result, status: 'underpaid' };
    }
  }

  return result;
}

module.exports = {
  Decimal,
  MONEY_DECIMALS,
  toMoney,
  decimalFromMongo,
  roundMoney,
  toMoneyNumber,
  compareMoney,
  moneyEquals,
  classifyFeePayment,
  classifyFeePaymentStatus,
};