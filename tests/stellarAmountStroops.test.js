'use strict';

/**
 * #842 — Amount/precision handling for Stellar (7-decimal stroops).
 *
 * Stellar amounts are exact integers in stroops (1 unit = 1e7 stroops). These
 * tests assert the centralized stroop utility is exact and, critically, that an
 * amount exactly equal to a fee is NEVER judged short/over by a float epsilon
 * (the headline acceptance criterion), including over a large property sweep.
 */

const {
  toStroops,
  fromStroops,
  stroopsToNumber,
  compareAmounts,
  amountsEqual,
  normalizeToNumber,
  STROOPS_PER_UNIT,
} = require('../backend/src/utils/stellarAmount');

describe('stellarAmount — toStroops / fromStroops', () => {
  test('whole numbers', () => {
    expect(toStroops('200')).toBe(2000000000n);
    expect(toStroops(200)).toBe(2000000000n);
  });

  test('Horizon-style 7-decimal strings', () => {
    expect(toStroops('100.0000000')).toBe(1000000000n);
    expect(toStroops('0.0000001')).toBe(1n); // 1 stroop, the minimum
  });

  test('rounds half-up beyond 7 decimals', () => {
    expect(toStroops('100.123456789')).toBe(1001234568n); // ...567|89 -> rounds up
    expect(toStroops('0.00000004')).toBe(0n);             // below half-stroop -> down
    expect(toStroops('0.00000005')).toBe(1n);             // exactly half -> up
  });

  test('round-trips exactly — even where float toFixed is lossy', () => {
    for (const v of ['0.0000001', '1.2345678', '100.0000000', '922337203685.4775807', '0.0000000']) {
      expect(fromStroops(toStroops(v))).toBe(v);
    }
    // The max int64 amount is NOT exactly representable as a JS float — this
    // precision loss is precisely why monetary math must use integer stroops (#842).
    expect(Number('922337203685.4775807').toFixed(7)).not.toBe('922337203685.4775807');
    expect(fromStroops(toStroops('922337203685.4775807'))).toBe('922337203685.4775807');
  });

  test('throws on garbage input', () => {
    expect(() => toStroops('abc')).toThrow();
    expect(() => toStroops(null)).toThrow();
    expect(() => toStroops(undefined)).toThrow();
  });
});

describe('stellarAmount — float traps are exact in stroop space', () => {
  test('0.1 + 0.2 (float) equals 0.3 in stroops', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a float; in stroops both are 3,000,000.
    expect(amountsEqual(0.1 + 0.2, '0.3')).toBe(true);
    expect(compareAmounts(0.1 + 0.2, 0.3)).toBe(0);
  });

  test('an exactly-equal payment vs fee compares equal', () => {
    expect(compareAmounts('250.0000000', 250)).toBe(0);
    expect(compareAmounts(250, '250')).toBe(0);
  });

  test('normalizeToNumber matches a clean parse but is float-safe', () => {
    expect(normalizeToNumber('100.1234568')).toBe(100.1234568);
    expect(normalizeToNumber('')).toBe(0);
    expect(normalizeToNumber(null)).toBe(0);
  });
});

describe('stellarAmount — property sweep over many amounts (#842)', () => {
  test('toStroops↔fromStroops round-trip + exact-equality never mis-flags', () => {
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      const stroops = BigInt(Math.floor(Math.random() * Number(STROOPS_PER_UNIT) * 100000));
      const decimal = fromStroops(stroops);

      // Round-trip is exact.
      expect(toStroops(decimal)).toBe(stroops);

      // A payment built from the same stroop count is ALWAYS judged equal —
      // never short or over by a rounding epsilon.
      const feeNumber = stroopsToNumber(stroops);
      expect(compareAmounts(decimal, feeNumber)).toBe(0);
      expect(amountsEqual(decimal, feeNumber)).toBe(true);

      // One stroop more is strictly greater; one stroop less strictly smaller.
      expect(compareAmounts(fromStroops(stroops + 1n), decimal)).toBe(1);
      if (stroops > 0n) {
        expect(compareAmounts(fromStroops(stroops - 1n), decimal)).toBe(-1);
      }
      checked++;
    }
    expect(checked).toBe(5000);
  });
});
