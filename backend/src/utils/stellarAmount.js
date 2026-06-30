'use strict';

/**
 * Stellar amount utilities — exact, float-safe monetary math (#842).
 *
 * Stellar represents every amount as a signed 64-bit integer count of
 * "stroops", where 1 unit (XLM or USDC — both use 7 decimal places) = 10,000,000
 * stroops. Horizon hands amounts back as decimal strings (e.g. "100.0000000").
 *
 * Doing arithmetic or comparisons on these as JS floats (parseFloat / toFixed)
 * risks off-by-epsilon errors: a payment that exactly equals the required fee
 * can be judged short or over by a rounding artifact. This module is the single
 * canonical place that converts to/from integer stroops (as BigInt) and compares
 * amounts in stroop space, so monetary decisions are always exact.
 */

const DECIMALS = 7;
const STROOPS_PER_UNIT = 10000000n; // 1e7

/**
 * Convert a decimal amount (string from Horizon or a JS number) to an exact
 * integer number of stroops as a BigInt. Fractional digits beyond 7 are rounded
 * half-up, matching Stellar's own precision rules.
 *
 * @param {string|number|bigint} amount
 * @returns {bigint} stroops
 */
function toStroops(amount) {
  if (typeof amount === 'bigint') return amount;
  if (amount === null || amount === undefined || amount === '') {
    throw new TypeError(`Cannot convert ${amount} to stroops`);
  }

  // Use a fixed-point string so we never depend on float arithmetic. For a JS
  // number, toFixed gives a decimal string already rounded to 7 places.
  let str = typeof amount === 'number' ? amount.toFixed(DECIMALS) : String(amount).trim();

  const negative = str.startsWith('-');
  if (negative) str = str.slice(1);

  if (!/^\d*(\.\d*)?$/.test(str) || str === '' || str === '.') {
    throw new TypeError(`Invalid amount for stroop conversion: ${amount}`);
  }

  const [intPart = '0', fracRaw = ''] = str.split('.');
  const frac = (fracRaw + '0'.repeat(DECIMALS)).slice(0, DECIMALS);

  let stroops = BigInt(intPart || '0') * STROOPS_PER_UNIT + BigInt(frac || '0');

  // Round half-up if there are more than 7 fractional digits.
  if (fracRaw.length > DECIMALS && Number(fracRaw[DECIMALS]) >= 5) {
    stroops += 1n;
  }

  return negative ? -stroops : stroops;
}

/**
 * Convert integer stroops back to a 7-decimal-place decimal string.
 * @param {bigint|number|string} stroops
 * @returns {string}
 */
function fromStroops(stroops) {
  const b = BigInt(stroops);
  const negative = b < 0n;
  const abs = negative ? -b : b;
  const intPart = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(DECIMALS, '0');
  return `${negative ? '-' : ''}${intPart}.${frac}`;
}

/**
 * Convert integer stroops to a JS number (7-decimal precision). Safe for the
 * full Stellar range when used for display/storage; comparisons should prefer
 * compareAmounts so they stay in exact stroop space.
 * @param {bigint|number|string} stroops
 * @returns {number}
 */
function stroopsToNumber(stroops) {
  return parseFloat(fromStroops(stroops));
}

/**
 * Compare two decimal amounts exactly in stroop space.
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
function compareAmounts(a, b) {
  const sa = toStroops(a);
  const sb = toStroops(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** True iff the two amounts are exactly equal to the stroop. */
function amountsEqual(a, b) {
  return compareAmounts(a, b) === 0;
}

/**
 * Normalize a raw Horizon amount to a JS number using exact stroop conversion.
 * Drop-in replacement for the old parseFloat/toFixed-based normalizer.
 * @param {string|number} rawAmount
 * @returns {number}
 */
function normalizeToNumber(rawAmount) {
  if (rawAmount === null || rawAmount === undefined || rawAmount === '') return 0;
  try {
    return stroopsToNumber(toStroops(rawAmount));
  } catch (_) {
    return 0;
  }
}

module.exports = {
  DECIMALS,
  STROOPS_PER_UNIT,
  toStroops,
  fromStroops,
  stroopsToNumber,
  compareAmounts,
  amountsEqual,
  normalizeToNumber,
};
