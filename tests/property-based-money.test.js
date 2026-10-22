'use strict';

const fc = require('fast-check');
const {
  toStroops, fromStroops, compareAmounts, sumStroops,
} = require('../backend/src/utils/stellarAmount');
const { classifyFeePayment } = require('../backend/src/utils/money');
const SEED = Number(process.env.FC_SEED || 18231824);
if (!Number.isInteger(SEED)) throw new TypeError(`FC_SEED must be an integer, got ${process.env.FC_SEED}`);
const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const stroopsArb = fc.bigInt({ min: MIN_INT64, max: MAX_INT64 });
const nonNegativeStroopsArb = fc.bigInt({ min: 0n, max: 1000000000000000000n });

function check(property, options = {}) {
  try {
    return fc.assert(property, { numRuns: options.numRuns || 250, ...options, seed: SEED });
  } catch (error) {
    // Keep the reproducer visible in CI logs, including when Jest truncates the
    // fast-check exception details.
    console.error(`[fast-check] seed=${SEED}`);
    throw error;
  }
}

function canonical(stroops) {
  return fromStroops(stroops);
}

describe('property-based Stellar money invariants (#1823)', () => {
  beforeAll(() => {
    console.info(`[fast-check] seed=${SEED}`);
  });

  test('every signed int64 stroop value round-trips exactly', () => {
    check(fc.property(stroopsArb, (value) => {
      expect(toStroops(fromStroops(value))).toBe(value);
    }));
  });

  test('valid seven-decimal strings round-trip without a float path', () => {
    check(fc.property(nonNegativeStroopsArb, (value) => {
      const text = canonical(value);
      expect(text).toMatch(/^\d+\.\d{7}$/);
      expect(fromStroops(toStroops(text))).toBe(text);
    }));
  });

  test('comparison is a total order in exact stroop space', () => {
    check(fc.property(stroopsArb, stroopsArb, stroopsArb, (a, b, c) => {
      expect(compareAmounts(canonical(a), canonical(b))).toBe(a < b ? -1 : a > b ? 1 : 0);
      expect(compareAmounts(canonical(a), canonical(a))).toBe(0);
      if (a <= b && b <= c) expect(compareAmounts(canonical(a), canonical(c))).toBeLessThanOrEqual(0);
    }));
  });

  test('exact SEP-0007 URI fields survive encode/decode round-trip', () => {
    const destination = 'G' + 'A'.repeat(55);
    check(fc.property(nonNegativeStroopsArb.filter((n) => n > 0n), fc.string({ minLength: 1, maxLength: 24 }), (amount, memo) => {
      const uri = `web+stellar:pay?${new URLSearchParams({ destination, amount: canonical(amount), memo, memo_type: 'MEMO_TEXT' })}`;
      const parsed = new URL(uri);
      expect(parsed.protocol).toBe('web+stellar:');
      expect(parsed.pathname).toBe('pay');
      expect(parsed.searchParams.get('destination')).toBe(destination);
      expect(toStroops(parsed.searchParams.get('amount'))).toBe(amount);
      expect(parsed.searchParams.get('memo')).toBe(memo);
      expect(parsed.searchParams.get('memo_type')).toBe('MEMO_TEXT');
    }));
  });

  test('installment classification preserves remaining/excess invariants', () => {
    check(fc.property(nonNegativeStroopsArb, fc.array(nonNegativeStroopsArb, { maxLength: 12 }), (fee, installments) => {
      const total = sumStroops(installments);
      const result = classifyFeePayment(canonical(total), canonical(fee));
      expect(result.remainingBalance).toBe(Math.max(0, Number(fee - total) / 10000000));
      expect(result.excessAmount).toBe(Math.max(0, Number(total - fee) / 10000000));
      expect(result.feePaid).toBe(total >= fee);
      expect(result.cumulativeTotal).toBe(Number(total) / 10000000);
    }));
  });

  test('report totals equal exact row sums and a balance event fold never goes negative', () => {
    check(fc.property(nonNegativeStroopsArb, fc.array(nonNegativeStroopsArb, { maxLength: 20 }), (opening, events) => {
      const rows = events.map((amount, index) => ({ id: index, amountStroops: amount }));
      expect(sumStroops(rows.map((row) => row.amountStroops))).toBe(sumStroops(events));
      let balance = opening;
      for (const paid of events) balance = balance > paid ? balance - paid : 0n;
      expect(balance >= 0n).toBe(true);
      const totalPaid = sumStroops(events);
      const expectedBalance = opening > totalPaid ? opening - totalPaid : 0n;
      expect(balance).toBe(expectedBalance);
    }));
  });
});
