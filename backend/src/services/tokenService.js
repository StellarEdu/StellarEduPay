'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { get, set, del } = require('../cache');
const { parseTTL } = require('./sessionStore');

const ISSUER = 'stellaredupay-api';
const AUDIENCE = 'stellaredupay-admin';
const ALGORITHM = 'HS256';

// ── Signing key ───────────────────────────────────────────────────────────────
// Derive a dedicated access-token signing key from JWT_SECRET via HKDF so the
// same secret used for MFA encryption / audit HMACs / unsubscribe tokens is not
// reused verbatim for access-token signatures (#1741). A dedicated
// JWT_SIGNING_KEY takes precedence when provided.

function getSigningKey() {
  if (process.env.JWT_SIGNING_KEY) return process.env.JWT_SIGNING_KEY;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('access-token'), 32)
  ).toString('hex');
}

function getAccessTTL() {
  return parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
}

// ── Session denylist ──────────────────────────────────────────────────────────

function revokedSidKey(sid) { return `revoked:sid:${sid}`; }

async function revokeSession(sid, ttlSeconds) {
  if (!sid) return;
  const ttl = ttlSeconds || getAccessTTL();
  set(revokedSidKey(sid), true, ttl);
  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    try {
      await redis.set(revokedSidKey(sid), '1', 'EX', ttl);
    } catch (e) {
      logger.warn('[TokenService] Redis error revoking session', { error: e.message });
    }
  }
}

async function isSessionRevoked(sid) {
  if (!sid) return false;
  if (get(revokedSidKey(sid))) return true;
  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    try {
      const val = await redis.get(revokedSidKey(sid));
      return Boolean(val);
    } catch (e) {
      logger.warn('[TokenService] Redis error checking session revocation', { error: e.message });
    }
  }
  return false;
}

// ── Sign / verify ─────────────────────────────────────────────────────────────

function sign(payload, options = {}) {
  const expiresIn = options.expiresIn || getAccessTTL();
  const sid = options.sid || crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { ...payload, sid },
    getSigningKey(),
    {
      algorithm: ALGORITHM,
      expiresIn,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: crypto.randomUUID(),
    }
  );
  return { token, sid, expiresIn };
}

function verify(token) {
  return jwt.verify(token, getSigningKey(), {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

module.exports = {
  ISSUER,
  AUDIENCE,
  ALGORITHM,
  sign,
  verify,
  revokeSession,
  isSessionRevoked,
  getAccessTTL,
};
