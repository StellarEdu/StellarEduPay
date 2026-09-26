'use strict';

/**
 * Tests for stellarTxHash.js — 64-character hex transaction hash validation.
 */

import {
  STELLAR_TX_HASH_RE,
  validateStellarTxHash,
  isValidStellarTxHash,
} from '../stellarTxHash';

const VALID_LOWER = '3389e9f0f1a65f19736cacf544c2e825313e8447f569233002f37e9d1399c504';
const VALID_UPPER = '3389E9F0F1A65F19736CACF544C2E825313E8447F569233002F37E9D1399C504';
const VALID_MIXED = '3389e9f0F1A65f19736cACF544c2E825313e8447F569233002f37E9D1399c504';

describe('STELLAR_TX_HASH_RE', () => {
  test('matches 64-char lowercase and uppercase hex strings', () => {
    expect(STELLAR_TX_HASH_RE.test(VALID_LOWER)).toBe(true);
    expect(STELLAR_TX_HASH_RE.test(VALID_UPPER)).toBe(true);
    expect(STELLAR_TX_HASH_RE.test(VALID_MIXED)).toBe(true);
  });

  test('rejects non-64 length strings', () => {
    expect(STELLAR_TX_HASH_RE.test('3389e9f0f1a65f19')).toBe(false);
    expect(STELLAR_TX_HASH_RE.test(VALID_LOWER + '0')).toBe(false);
  });

  test('rejects non-hex characters', () => {
    const invalid = VALID_LOWER.slice(0, 63) + 'z';
    expect(STELLAR_TX_HASH_RE.test(invalid)).toBe(false);
  });
});

describe('validateStellarTxHash', () => {
  test('accepts valid 64-char hex and returns normalized lowercase', () => {
    const result = validateStellarTxHash(`  ${VALID_UPPER}  `);
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe(VALID_LOWER);
    expect(result.error).toBeNull();
  });

  test('rejects empty input', () => {
    const result = validateStellarTxHash('');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('REQUIRED');
  });

  test('rejects invalid length', () => {
    const result = validateStellarTxHash('abc123');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_LENGTH');
  });

  test('rejects non-hex characters', () => {
    const result = validateStellarTxHash(VALID_LOWER.slice(0, 63) + 'g');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_FORMAT');
  });
});

describe('isValidStellarTxHash', () => {
  test('returns true for valid hashes and false for invalid', () => {
    expect(isValidStellarTxHash(VALID_LOWER)).toBe(true);
    expect(isValidStellarTxHash('invalid')).toBe(false);
  });
});
