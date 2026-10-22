'use strict';

/**
 * Tests for issue #1809 — signed per-student payment links that replace raw
 * student IDs on public endpoints.
 */

const { generatePayLinkToken, verifyPayLinkToken, DEFAULT_EXPIRY_SECONDS } = require('../src/utils/payLinkToken');

const SECRET = 'test-secret';
const NOW = 1_800_000_000;

describe('issue #1809 — pay link tokens', () => {
  test('a freshly generated token verifies and returns its binding', () => {
    const token = generatePayLinkToken({ schoolId: 'school-1', studentId: 'STU-ABC123', linkVersion: 2 }, SECRET, NOW);
    expect(verifyPayLinkToken(token, SECRET, NOW)).toEqual({
      valid: true,
      schoolId: 'school-1',
      studentId: 'STU-ABC123',
      linkVersion: 2,
    });
  });

  test('defaults linkVersion to 0 and expires after 30 days', () => {
    const token = generatePayLinkToken({ schoolId: 'school-1', studentId: 'STU-ABC123' }, SECRET, NOW);
    const justBeforeExpiry = NOW + DEFAULT_EXPIRY_SECONDS - 1;
    expect(verifyPayLinkToken(token, SECRET, justBeforeExpiry)).toMatchObject({ valid: true, linkVersion: 0 });
    expect(verifyPayLinkToken(token, SECRET, NOW + DEFAULT_EXPIRY_SECONDS)).toEqual({ valid: false, error: 'Token expired' });
  });

  test('rejects a token signed with a different secret', () => {
    const token = generatePayLinkToken({ schoolId: 'school-1', studentId: 'STU-ABC123' }, SECRET, NOW);
    expect(verifyPayLinkToken(token, 'other-secret', NOW)).toEqual({ valid: false, error: 'Invalid signature' });
  });

  test('rejects a payload that was tampered with after signing', () => {
    const token = generatePayLinkToken({ schoolId: 'school-1', studentId: 'STU-ABC123' }, SECRET, NOW);
    const [, signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ s: 'school-1', t: 'STU-ZZZZZZ', v: 0, e: NOW + 100 })).toString('base64url');
    expect(verifyPayLinkToken(`${forgedPayload}.${signature}`, SECRET, NOW)).toEqual({ valid: false, error: 'Invalid signature' });
  });

  test('IDs containing dots or separators round-trip safely', () => {
    const token = generatePayLinkToken({ schoolId: 'school.a:b', studentId: 'STU.1:x' }, SECRET, NOW);
    expect(verifyPayLinkToken(token, SECRET, NOW)).toMatchObject({ valid: true, schoolId: 'school.a:b', studentId: 'STU.1:x' });
  });

  test('rejects malformed input without throwing', () => {
    expect(verifyPayLinkToken('no-dot-here', SECRET, NOW)).toEqual({ valid: false, error: 'Invalid token format' });
    expect(verifyPayLinkToken('a.b.c', SECRET, NOW)).toEqual({ valid: false, error: 'Invalid token format' });
    expect(verifyPayLinkToken(undefined, SECRET, NOW)).toEqual({ valid: false, error: 'Invalid token format' });
  });

  test('refuses to generate or verify without a signing secret', () => {
    expect(() => generatePayLinkToken({ schoolId: 's', studentId: 't' }, '', NOW)).toThrow(/signing secret/);
    expect(() => verifyPayLinkToken('a.b', undefined, NOW)).toThrow(/signing secret/);
  });

  test('refuses to generate a token without a school and student', () => {
    expect(() => generatePayLinkToken({ schoolId: 's' }, SECRET, NOW)).toThrow(/schoolId and studentId/);
  });
});
