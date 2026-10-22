'use strict';

/**
 * Signed per-student payment link tokens (#1809).
 *
 * A token binds a school, a student and a revocable `linkVersion` to an expiry
 * time, so public pay pages can be reached without typing a raw student ID.
 *
 * Format: base64url(JSON payload).base64url(HMAC-SHA256 of the encoded payload)
 * Payload: { s: schoolId, t: studentId, v: linkVersion, e: expiresAtUnixSeconds }
 *
 * Bumping a student's linkVersion invalidates every token issued before it.
 */

const crypto = require('crypto');

const DEFAULT_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

function sign(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('payLinkToken: a non-empty signing secret is required');
  }
}

/**
 * @param {object} params
 * @param {string} params.schoolId
 * @param {string} params.studentId
 * @param {number} [params.linkVersion=0] - bump to revoke older links
 * @param {number} [params.expiresInSeconds=30 days]
 * @param {string} secret
 * @param {number} [nowSeconds] - injectable clock for tests
 * @returns {string}
 */
function generatePayLinkToken(
  { schoolId, studentId, linkVersion = 0, expiresInSeconds = DEFAULT_EXPIRY_SECONDS },
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  requireSecret(secret);
  if (!schoolId || !studentId) {
    throw new Error('payLinkToken: schoolId and studentId are required');
  }
  const payload = {
    s: String(schoolId),
    t: String(studentId),
    v: Number(linkVersion),
    e: nowSeconds + expiresInSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

/**
 * Verify a token. The caller must still check that `linkVersion` matches the
 * student's current version before trusting the token.
 *
 * @param {string} token
 * @param {string} secret
 * @param {number} [nowSeconds] - injectable clock for tests
 * @returns {{valid: true, schoolId: string, studentId: string, linkVersion: number}
 *          | {valid: false, error: string}}
 */
function verifyPayLinkToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  requireSecret(secret);
  if (typeof token !== 'string') {
    return { valid: false, error: 'Invalid token format' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'Invalid token format' };
  }

  const [encodedPayload, signature] = parts;
  const expected = Buffer.from(sign(encodedPayload, secret));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return { valid: false, error: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, error: 'Invalid token payload' };
  }

  if (!payload || typeof payload.s !== 'string' || typeof payload.t !== 'string' ||
      !Number.isInteger(payload.v) || !Number.isFinite(payload.e)) {
    return { valid: false, error: 'Invalid token payload' };
  }

  if (nowSeconds >= payload.e) {
    return { valid: false, error: 'Token expired' };
  }

  return { valid: true, schoolId: payload.s, studentId: payload.t, linkVersion: payload.v };
}

module.exports = { generatePayLinkToken, verifyPayLinkToken, DEFAULT_EXPIRY_SECONDS };
