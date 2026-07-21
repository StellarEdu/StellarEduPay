'use strict';

// Must set required env vars before any module that loads config/index.js
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const { extractMemo, extractByType } = require('../backend/src/services/parsers/memoExtractor');

describe('memoExtractor', () => {
  describe('extractMemo', () => {
    it('should handle missing memo', () => {
      const result = extractMemo({ memo: null });
      expect(result.content).toBeNull();
      expect(result.type).toBeNull();
    });

    it('should handle empty string memo', () => {
      const result = extractMemo({ memo: '' });
      expect(result.content).toBeNull();
      expect(result.type).toBeNull();
    });

    it('should extract string memo as MEMO_TEXT', () => {
      const result = extractMemo({ memo: 'STU001' });
      expect(result.content).toBe('STU001');
      expect(result.type).toBe('MEMO_TEXT');
      expect(result.encoding).toBeNull();
    });

    it('should trim whitespace from string memo', () => {
      const result = extractMemo({ memo: '  STU001  ' });
      expect(result.content).toBe('STU001');
      expect(result.type).toBe('MEMO_TEXT');
    });
  });

  describe('extractByType', () => {
    it('should extract MEMO_TEXT type', () => {
      const memoData = { type: 'text', value: 'STU001' };
      const result = extractByType(memoData);
      expect(result.content).toBe('STU001');
      expect(result.type).toBe('MEMO_TEXT');
    });

    it('should extract MEMO_TEXT with uppercase type', () => {
      const memoData = { type: 'MEMO_TEXT', value: 'STU001' };
      const result = extractByType(memoData);
      expect(result.content).toBe('STU001');
      expect(result.type).toBe('MEMO_TEXT');
    });

    // #1118 — MEMO_ID and MEMO_HASH now resolve to the canonical payment
    // reference so wallets that cannot send free-text memos still match.
    it('should decode MEMO_ID to the canonical payment reference', () => {
      const memoData = { type: 'id', value: '12345' };
      const result = extractByType(memoData);
      expect(result.content).toBe('00003039');
      expect(result.type).toBe('MEMO_ID');
    });

    it('should reject a MEMO_ID outside the 32-bit reference space', () => {
      // Exchange-style routing identifiers must not be truncated into a match.
      const memoData = { type: 'id', value: '18446744073709551615' };
      const result = extractByType(memoData);
      expect(result.content).toBeNull();
      expect(result.type).toBe('MEMO_ID');
    });

    it('should decode a MEMO_HASH carrying a canonical reference', () => {
      const memoData = { type: 'hash', value: `${'00'.repeat(28)}a3f91b2c` };
      const result = extractByType(memoData);
      expect(result.content).toBe('A3F91B2C');
      expect(result.type).toBe('MEMO_HASH');
      expect(result.encoding).toBe('hex');
    });

    it('should reject a MEMO_HASH that is a foreign 32-byte value', () => {
      const memoData = { type: 'hash', value: 'ab'.repeat(32) };
      const result = extractByType(memoData);
      expect(result.content).toBeNull();
      expect(result.type).toBe('MEMO_HASH');
      expect(result.encoding).toBe('hex');
    });

    it('should reject a malformed MEMO_HASH', () => {
      const memoData = { type: 'hash', value: 'abc123def456' };
      const result = extractByType(memoData);
      expect(result.content).toBeNull();
      expect(result.type).toBe('MEMO_HASH');
      expect(result.encoding).toBe('hex');
    });

    it('should reject MEMO_RETURN type', () => {
      const memoData = { type: 'return', value: 'abc123def456' };
      const result = extractByType(memoData);
      expect(result.content).toBeNull();
      expect(result.type).toBe('MEMO_RETURN');
      expect(result.encoding).toBe('hex');
    });

    it('should handle unknown memo type', () => {
      const memoData = { type: 'unknown', value: 'something' };
      const result = extractByType(memoData);
      expect(result.content).toBeNull();
      expect(result.type).toBe('UNKNOWN');
    });

    it('should handle underscore-prefixed type fields', () => {
      const memoData = { _type: 'text', _value: 'STU001' };
      const result = extractByType(memoData);
      expect(result.content).toBe('STU001');
      expect(result.type).toBe('MEMO_TEXT');
    });

    it('should handle null value', () => {
      const memoData = { type: 'text', value: null };
      const result = extractByType(memoData);
      expect(result.content).toBeNull();
      expect(result.type).toBe('MEMO_TEXT');
    });
  });
});
