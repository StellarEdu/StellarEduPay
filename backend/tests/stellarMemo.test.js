'use strict';

/**
 * Tests for backend/src/utils/stellarMemo.js (#1118).
 *
 * This module is the decode half of a contract whose encode half lives in
 * frontend/src/utils/stellarMemo.js. The "wire form" fixtures below are the
 * exact strings the frontend encoder produces, so a drift in either direction
 * fails here.
 */

const {
  SUPPORTED_MEMO_TYPES,
  normalizeMemoType,
  isCanonicalMemo,
  decodeMemoToCanonical,
} = require('../src/utils/stellarMemo');

const MEMO = 'A3F91B2C';
const WIRE = {
  MEMO_TEXT: MEMO,
  MEMO_ID: '2751011628',
  MEMO_HASH: Buffer.concat([Buffer.alloc(28), Buffer.from(MEMO, 'hex')]).toString('base64'),
};

describe('normalizeMemoType', () => {
  test("accepts Horizon's lowercase spelling", () => {
    expect(normalizeMemoType('text')).toBe('MEMO_TEXT');
    expect(normalizeMemoType('id')).toBe('MEMO_ID');
    expect(normalizeMemoType('hash')).toBe('MEMO_HASH');
  });

  test('returns null for unsupported and absent types', () => {
    expect(normalizeMemoType('return')).toBeNull();
    expect(normalizeMemoType('none')).toBeNull();
    expect(normalizeMemoType(undefined)).toBeNull();
  });
});

describe('isCanonicalMemo', () => {
  test('accepts 8-hex-character intent memos', () => {
    expect(isCanonicalMemo(MEMO)).toBe(true);
    expect(isCanonicalMemo('a3f91b2c')).toBe(true);
  });

  test('rejects free text', () => {
    expect(isCanonicalMemo('STU1023')).toBe(false);
    expect(isCanonicalMemo('')).toBe(false);
    expect(isCanonicalMemo(null)).toBe(false);
  });
});

describe('decodeMemoToCanonical', () => {
  test.each(SUPPORTED_MEMO_TYPES)('decodes the frontend wire form for %s', (type) => {
    expect(decodeMemoToCanonical(WIRE[type], type)).toBe(MEMO);
  });

  test.each([
    ['text', WIRE.MEMO_TEXT],
    ['id', WIRE.MEMO_ID],
    ['hash', WIRE.MEMO_HASH],
  ])("decodes Horizon's '%s' spelling", (type, value) => {
    expect(decodeMemoToCanonical(value, type)).toBe(MEMO);
  });

  test('accepts a numeric MEMO_ID as reported by some Horizon clients', () => {
    expect(decodeMemoToCanonical(2751011628, 'id')).toBe(MEMO);
  });

  test('MEMO_ID outside the 32-bit memo space does not match', () => {
    // Exchanges routinely use large MEMO_ID values for account routing. Those
    // must not be truncated into a collision with a real intent memo.
    expect(decodeMemoToCanonical('4294967296', 'id')).toBeNull();
    expect(decodeMemoToCanonical('18446744073709551615', 'id')).toBeNull();
  });

  test('MEMO_HASH carrying a foreign 32-byte value does not match', () => {
    const foreign = Buffer.alloc(32, 0xab).toString('base64');
    expect(decodeMemoToCanonical(foreign, 'hash')).toBeNull();
  });

  test('MEMO_HASH accepts the hex encoding Horizon returns in JSON', () => {
    const hex = `${'00'.repeat(28)}${MEMO.toLowerCase()}`;
    expect(decodeMemoToCanonical(hex, 'hash')).toBe(MEMO);
  });

  test('MEMO_HASH rejects malformed base64', () => {
    expect(decodeMemoToCanonical('!!!not-base64!!!', 'hash')).toBeNull();
  });

  test('MEMO_TEXT still passes raw student IDs through unchanged', () => {
    // The pre-#1118 matching path stays intact for schools that publish a
    // student ID as the memo rather than an intent reference.
    expect(decodeMemoToCanonical('STU1023', 'text')).toBe('STU1023');
    expect(decodeMemoToCanonical('  STU1023  ', 'text')).toBe('STU1023');
  });

  test('MEMO_RETURN and empty memos yield null', () => {
    expect(decodeMemoToCanonical(WIRE.MEMO_HASH, 'return')).toBeNull();
    expect(decodeMemoToCanonical('', 'text')).toBeNull();
    expect(decodeMemoToCanonical(null, 'text')).toBeNull();
    expect(decodeMemoToCanonical(undefined, 'id')).toBeNull();
  });
});
