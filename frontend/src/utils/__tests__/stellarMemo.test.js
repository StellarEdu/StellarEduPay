'use strict';

/**
 * Tests for stellarMemo.js — SEP-0007 memo encoding/decoding (#1118).
 *
 * The backend mirror (backend/src/utils/stellarMemo.js) must decode whatever
 * this module encodes; backend/tests/stellarMemo.test.js asserts the same
 * round-trips from the other side.
 */

import {
  MEMO_TYPES,
  normalizeMemoType,
  isEncodableMemo,
  encodeMemo,
  decodeMemo,
} from '../stellarMemo';

const MEMO = 'A3F91B2C';
const MEMO_AS_ID = String(parseInt(MEMO, 16)); // 2751011628

describe('normalizeMemoType', () => {
  test('expands short forms to the SEP-0007 spelling', () => {
    expect(normalizeMemoType('text')).toBe('MEMO_TEXT');
    expect(normalizeMemoType('id')).toBe('MEMO_ID');
    expect(normalizeMemoType('hash')).toBe('MEMO_HASH');
  });

  test('passes through full forms unchanged', () => {
    expect(normalizeMemoType('MEMO_ID')).toBe('MEMO_ID');
  });

  test('defaults to MEMO_TEXT when unset', () => {
    expect(normalizeMemoType(undefined)).toBe('MEMO_TEXT');
  });

  test('throws for MEMO_RETURN, which has no canonical encoding', () => {
    expect(() => normalizeMemoType('MEMO_RETURN')).toThrow('Unsupported memo type');
  });
});

describe('isEncodableMemo', () => {
  test('accepts canonical 8-hex-character intent memos', () => {
    expect(isEncodableMemo(MEMO)).toBe(true);
    expect(isEncodableMemo('00000000')).toBe(true);
    expect(isEncodableMemo('ffffffff')).toBe(true); // case-insensitive
  });

  test('rejects free-text memos such as raw student IDs', () => {
    expect(isEncodableMemo('STU1023')).toBe(false);
    expect(isEncodableMemo('A3F91B2')).toBe(false);  // too short
    expect(isEncodableMemo('A3F91B2CD')).toBe(false); // too long
    expect(isEncodableMemo('G3F91B2C')).toBe(false);  // non-hex
  });
});

describe('encodeMemo', () => {
  test('MEMO_TEXT is sent verbatim', () => {
    expect(encodeMemo(MEMO, 'MEMO_TEXT')).toBe(MEMO);
    expect(encodeMemo('STU1023', 'MEMO_TEXT')).toBe('STU1023');
  });

  test('MEMO_TEXT rejects memos over the 28-byte on-chain limit', () => {
    expect(() => encodeMemo('x'.repeat(29), 'MEMO_TEXT')).toThrow('28-byte');
  });

  test('MEMO_ID is the unsigned decimal form of the hex memo', () => {
    expect(encodeMemo(MEMO, 'MEMO_ID')).toBe(MEMO_AS_ID);
    expect(encodeMemo('00000001', 'MEMO_ID')).toBe('1');
  });

  test('MEMO_HASH is 32 bytes, base64, right-aligned', () => {
    const encoded = encodeMemo(MEMO, 'MEMO_HASH');
    const bytes = Buffer.from(encoded, 'base64');
    expect(bytes).toHaveLength(32);
    expect(bytes.subarray(0, 28).every((b) => b === 0)).toBe(true);
    expect(bytes.subarray(28).toString('hex').toUpperCase()).toBe(MEMO);
  });

  test('refuses to encode a free-text memo as MEMO_ID or MEMO_HASH', () => {
    expect(() => encodeMemo('STU1023', 'MEMO_ID')).toThrow('cannot be encoded');
    expect(() => encodeMemo('STU1023', 'MEMO_HASH')).toThrow('cannot be encoded');
  });
});

describe('decodeMemo', () => {
  test.each(MEMO_TYPES)('round-trips a canonical memo through %s', (type) => {
    expect(decodeMemo(encodeMemo(MEMO, type), type)).toBe(MEMO);
  });

  test('MEMO_ID pads short values back to 8 hex characters', () => {
    expect(decodeMemo('1', 'MEMO_ID')).toBe('00000001');
  });

  test('MEMO_ID rejects values outside the 32-bit memo space', () => {
    // A wallet using MEMO_ID for exchange routing must not be truncated into
    // a false match against an unrelated intent.
    expect(decodeMemo('4294967296', 'MEMO_ID')).toBeNull();
    expect(decodeMemo('18446744073709551615', 'MEMO_ID')).toBeNull();
    expect(decodeMemo('-1', 'MEMO_ID')).toBeNull();
    expect(decodeMemo('not-a-number', 'MEMO_ID')).toBeNull();
  });

  test('MEMO_HASH rejects a genuine 32-byte hash from another protocol', () => {
    const foreign = Buffer.alloc(32, 0xab).toString('base64');
    expect(decodeMemo(foreign, 'MEMO_HASH')).toBeNull();
  });

  test('MEMO_HASH rejects a wrong-length value', () => {
    expect(decodeMemo(Buffer.alloc(16).toString('base64'), 'MEMO_HASH')).toBeNull();
  });

  test('MEMO_HASH also accepts the hex form Horizon reports', () => {
    const hex = `${'00'.repeat(28)}${MEMO.toLowerCase()}`;
    expect(decodeMemo(hex, 'MEMO_HASH')).toBe(MEMO);
  });

  test('MEMO_TEXT passes free text through for existing student-ID matching', () => {
    expect(decodeMemo('STU1023', 'MEMO_TEXT')).toBe('STU1023');
    expect(decodeMemo('  STU1023  ', 'MEMO_TEXT')).toBe('STU1023');
  });

  test('returns null for empty and unsupported input', () => {
    expect(decodeMemo('', 'MEMO_TEXT')).toBeNull();
    expect(decodeMemo(null, 'MEMO_TEXT')).toBeNull();
    expect(decodeMemo(MEMO, 'MEMO_RETURN')).toBeNull();
  });
});
