'use strict';

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

/** Parse any monetary value (Number, numeric string, Decimal, null) into a Decimal. */
function toMoney(value) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value);
}

/**
 * A Mongo aggregate field produced via `{ $sum: { $toDecimal: '$field' } }`
 * comes back as a BSON Decimal128. Decimal128#toString() is exact, so it is
 * safe to feed straight into decimal.js.
 */
function decimalFromMongo(value) {
  if (value === null || value === undefined) return new Decimal(0);
  return new Decimal(value.toString());
}

/** Round to Stellar's 7 decimal places, half-up. Returns a Decimal. */
function roundMoney(value) {
  return toMoney(value).toDecimalPlaces(MONEY_DECIMALS, ROUNDING);
}

/** Round to 7dp and convert to a plain JS Number — use only at the output boundary. */
function toMoneyNumber(value) {
  return roundMoney(value).toNumber();
}

/** -1 / 0 / 1, exact — never affected by float epsilon. */
function compareMoney(a, b) {
  return toMoney(a).cmp(toMoney(b));
}

function moneyEquals(a, b) {
  return compareMoney(a, b) === 0;
}

/**
 * Classify a student's cumulative payment total against their fee, and derive
 * excessAmount / remainingBalance — all in exact Decimal space. Replaces the
 * `parseFloat(x.toFixed(7))` + `<`/`>`/`===` logic that used to live inline in
 * paymentController.verifyPayment and utils/studentBalanceUpdater.
 *
 * @param {Decimal|number|string} cumulativeTotal - total successfully paid so far
 * @param {Decimal|number|string} feeAmount - the fee owed
 */
function classifyFeePayment(cumulativeTotal, feeAmount) {
  const cumulative = roundMoney(cumulativeTotal);
  const fee = toMoney(feeAmount);
  const cmp = cumulative.cmp(fee);

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
};
