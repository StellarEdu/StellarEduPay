'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { get, set, del } = require('../cache');
const { parseTTL } = require('../utils/ttl');

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

// ── Access-token payload ──────────────────────────────────────────────────────
// Single source of truth for the access-token claims. Every issuer (login,
// refresh, MFA re-issue) must build its payload here so that tokenVersion is
// never omitted — the auth middleware compares it against the stored value and
// rejects mismatches (#2035).

function buildAccessPayload(user) {
  if (!user) throw new Error('buildAccessPayload requires a user');
  const payload = {
    role: user.role,
    userId: user.id || user.userId,
    schoolId: user.schoolId,
    roles: user.roles,
    tokenVersion: user.tokenVersion || 0,
  };
  if (user.mfaSetupPending) payload.mfaSetupPending = true;
  return payload;
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
  const decoded = jwt.verify(token, getSigningKey(), {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  // #1940 — once legacy tokens (no sid) have expired, set REQUIRE_SESSION_ID=true so
  // tokens that cannot be revoked by session are refused. Off by default for one release.
  if (process.env.REQUIRE_SESSION_ID === 'true' && !decoded.sid) {
    throw new jwt.JsonWebTokenError('session id (sid) required');
  }
  return decoded;
}

// Key-explicit helpers for token families that intentionally use their own
// key and audience (e.g. parent portal links). They keep jsonwebtoken confined
// to this module; access tokens must use sign()/verify() above.
function signWithKey(payload, key, options = {}) {
  return jwt.sign(payload, key, { algorithm: ALGORITHM, ...options });
}

function verifyWithKey(token, key, options = {}) {
  return jwt.verify(token, key, { algorithms: [ALGORITHM], ...options });
}

module.exports = {
  ISSUER,
  AUDIENCE,
  ALGORITHM,
  sign,
  verify,
  buildAccessPayload,
  signWithKey,
  verifyWithKey,
  revokeSession,
  isSessionRevoked,
  getAccessTTL,
};
