'use strict';

/**
 * TOTP second factor for the environment super-admin (break-glass) account.
 *
 * The env account is not a User document, so it cannot use the per-user
 * `mfaSecret` path. Its secret comes from ADMIN_TOTP_SECRET (base32).
 *
 * Replay protection: each accepted 30-second TOTP step is recorded once. The
 * record is written with Redis SET NX when Redis is ready, so replicas share
 * it; otherwise an in-process map is used. A code from a step that has already
 * been accepted is rejected even if it is still inside the drift window.
 */

const speakeasy = require('speakeasy');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const logger = require('../utils/logger').child('AdminTotp');

const STEP_SECONDS = 30;
const DRIFT_WINDOW = 1;
const USED_STEP_TTL_MS = 180 * 1000;

// In-process fallback: key -> expiry (ms epoch).
const usedSteps = new Map();

function getAdminTotpSecret() {
  const secret = process.env.ADMIN_TOTP_SECRET;
  return secret && secret.trim() ? secret.trim() : null;
}

function isAdminTotpConfigured() {
  return getAdminTotpSecret() !== null;
}

function markLocalStepUsed(key) {
  const now = Date.now();
  for (const [k, expiresAt] of usedSteps) {
    if (expiresAt <= now) usedSteps.delete(k);
  }
  if (usedSteps.has(key)) return false;
  usedSteps.set(key, now + USED_STEP_TTL_MS);
  return true;
}

/**
 * Atomically records that `step` has been used.
 * @returns {Promise<boolean>} true if this is the first use of the step.
 */
async function markStepUsed(step) {
  const key = `adminTotp:used:${step}`;
  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    try {
      const reply = await redis.set(key, '1', 'EX', Math.ceil(USED_STEP_TTL_MS / 1000), 'NX');
      return reply === 'OK';
    } catch (err) {
      logger.warn('Redis error recording admin TOTP step; using in-process guard', { error: err.message });
    }
  }
  return markLocalStepUsed(key);
}

/**
 * @param {unknown} code  six-digit TOTP code supplied by the caller
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'not_configured' | 'invalid' | 'replayed' }>}
 */
async function verifyAdminTotp(code) {
  const secret = getAdminTotpSecret();
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return { ok: false, reason: 'invalid' };
  }

  let result;
  try {
    result = speakeasy.totp.verifyDelta({
      secret,
      encoding: 'base32',
      token: code.trim(),
      window: DRIFT_WINDOW,
    });
  } catch {
    // Malformed ADMIN_TOTP_SECRET: fail closed, do not reveal the cause to the caller.
    logger.error('ADMIN_TOTP_SECRET is not valid base32; admin TOTP verification refused');
    return { ok: false, reason: 'not_configured' };
  }
  if (!result) return { ok: false, reason: 'invalid' };

  const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + result.delta;
  const firstUse = await markStepUsed(step);
  if (!firstUse) return { ok: false, reason: 'replayed' };

  return { ok: true };
}

module.exports = {
  isAdminTotpConfigured,
  verifyAdminTotp,
};
