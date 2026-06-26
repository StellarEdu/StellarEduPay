'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { get, set, del } = require('../cache');
const { sendAdminAlert } = require('../services/alertService');

// ── Constant-time string comparison ───────────────────────────────────────────

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // consume equal time
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Refresh token store (Redis when available, in-process Map otherwise) ──────

let _store;

function getStore() {
  if (_store) return _store;

  if (process.env.REDIS_HOST) {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      _store = {
        async set(token, ttlSeconds) {
          await client.set(`refresh:${token}`, '1', 'EX', ttlSeconds);
        },
        async has(token) {
          return (await client.exists(`refresh:${token}`)) === 1;
        },
        async del(token) {
          await client.del(`refresh:${token}`);
        },
      };
    } else {
      logger.warn('[AuthController] Redis unavailable — falling back to in-memory refresh token store');
      const map = new Map();
      _store = {
        async set(token, ttlSeconds) { map.set(token, Date.now() + ttlSeconds * 1000); },
        async has(token) {
          const exp = map.get(token);
          if (!exp) return false;
          if (Date.now() > exp) { map.delete(token); return false; }
          return true;
        },
        async del(token) { map.delete(token); },
      };
    }
  } else {
    const map = new Map();
    _store = {
      async set(token, ttlSeconds) { map.set(token, Date.now() + ttlSeconds * 1000); },
      async has(token) {
        const exp = map.get(token);
        if (!exp) return false;
        if (Date.now() > exp) { map.delete(token); return false; }
        return true;
      },
      async del(token) { map.delete(token); },
    };
  }

  return _store;
}

function _resetStore() { _store = null; }

// ── Per-account login lockout ─────────────────────────────────────────────────
// Counters are shared across replicas via Redis when available; the in-process
// node-cache acts as a write-through layer so lock checks remain synchronous
// on the hot path (the test suite also benefits from this sync behaviour).

const LOGIN_FAIL_WINDOW = 900;   // 15 min window
const LOGIN_FAIL_THRESHOLD = 5;  // lock after 5 failures
const LOGIN_LOCK_TTL = 900;      // lock duration: 15 min

function loginLockKey(id) { return `loginLock:${id}`; }
function loginFailKey(id) { return `loginFail:${id}`; }

function isLockedOut(loginId) {
  // Sync in-memory check (fast path, no I/O)
  return Boolean(get(loginLockKey(loginId)));
}

async function recordLoginFailure(loginId) {
  const fk = loginFailKey(loginId);
  const lk = loginLockKey(loginId);

  // Update in-memory counter
  const prevCount = get(fk) || 0;
  const newCount = prevCount + 1;
  set(fk, newCount, LOGIN_FAIL_WINDOW);

  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    try {
      const count = await redis.incr(fk);
      if (count === 1) await redis.expire(fk, LOGIN_FAIL_WINDOW);
      if (count >= LOGIN_FAIL_THRESHOLD) {
        await redis.set(lk, '1', 'EX', LOGIN_LOCK_TTL);
        set(lk, true, LOGIN_LOCK_TTL); // mirror to in-memory for sync reads
        await sendAdminAlert(`Login lockout triggered for "${loginId}"`, { loginId, failCount: count });
      }
    } catch (e) {
      logger.warn('[AuthController] Redis error tracking login failure', { error: e.message });
    }
  } else if (newCount >= LOGIN_FAIL_THRESHOLD) {
    set(lk, true, LOGIN_LOCK_TTL);
    await sendAdminAlert(`Login lockout triggered for "${loginId}"`, { loginId, failCount: newCount });
  }
}

function clearLoginFailures(loginId) {
  const fk = loginFailKey(loginId);
  const lk = loginLockKey(loginId);
  del(fk, lk);
  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    redis.del(fk, lk).catch(() => {});
  }
}

// ── Cookies ───────────────────────────────────────────────────────────────────

const ACCESS_COOKIE = 'admin_token';
const REFRESH_COOKIE = 'admin_refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';

function accessCookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlSeconds * 1000,
    path: '/',
  };
}

function refreshCookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlSeconds * 1000,
    path: REFRESH_COOKIE_PATH,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTTL(envVar, defaultSeconds) {
  const val = process.env[envVar];
  if (!val) return defaultSeconds;
  const match = val.match(/^(\d+)([smhd]?)$/);
  if (!match) return defaultSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, '': 1 };
  return n * (multipliers[unit] ?? 1);
}

// ── Login handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 *
 * Accepts { username, password } for the env super-admin (break-glass) and
 * { email, password, mfaCode? } for DB-registered school users.
 *
 * Per-account lockout is enforced via an in-memory counter (Redis-backed when
 * REDIS_HOST is set) keyed by the normalised login identifier.
 *
 * When a school has MFA enabled and the caller provides a valid password but
 * no mfaCode, the response is { requiresMfa: true } (HTTP 200) so the client
 * can prompt for the second factor before re-submitting.
 */
async function handleLogin(req, res) {
  const { username, email, password, mfaCode } = req.body || {};
  const loginId = ((email || username) || '').trim().toLowerCase();

  // ── Per-account lockout (sync fast-path via in-process cache) ──────────────
  if (isLockedOut(loginId)) {
    return res.status(429).json({
      error: 'Too many failed login attempts. Account temporarily locked.',
      code: 'ACCOUNT_LOCKED',
    });
  }

  // ── ENV super-admin path (username-based, backward-compatible) ─────────────
  // When only `username` is supplied (no `email`), we bypass the DB and check
  // against ADMIN_USERNAME / ADMIN_PASSWORD_HASH (or legacy ADMIN_PASSWORD).
  // This preserves the existing authLogin.test.js contract and keeps the hot
  // path synchronous so tests can call handleLogin without await.
  if (!email) {
    const envUsername = process.env.ADMIN_USERNAME;
    const envPasswordHash = process.env.ADMIN_PASSWORD_HASH;
    const envPassword = process.env.ADMIN_PASSWORD;

    if (!envUsername || (!envPassword && !envPasswordHash)) {
      return res.status(500).json({
        error: 'Server misconfiguration: ADMIN_USERNAME or ADMIN_PASSWORD is not set.',
        code: 'AUTH_MISCONFIGURED',
      });
    }

    const usernameMatch = loginId ? safeEqual(loginId, envUsername) : false;
    let credValid = false;

    if (envPasswordHash) {
      // Async bcrypt path — used when ADMIN_PASSWORD_HASH is configured
      credValid = usernameMatch && Boolean(password) && await bcrypt.compare(password, envPasswordHash);
    } else {
      // Legacy sync path — used when only ADMIN_PASSWORD is set (no await needed)
      credValid = usernameMatch && Boolean(password) && safeEqual(password, envPassword);
    }

    if (!credValid) {
      recordLoginFailure(loginId).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
    }

    // Success — clear failure counter (fire-and-forget)
    clearLoginFailures(loginId);

    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

    // Preserve backward-compat JWT shape; append new fields for new consumers
    const token = jwt.sign(
      { role: 'admin', username: loginId, userId: 'super_admin', roles: ['super_admin'] },
      secret,
      { expiresIn: accessTTL }
    );

    const refreshToken = crypto.randomBytes(40).toString('hex');
    getStore().set(refreshToken, refreshTTL).catch(() => {});

    res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

    return res.json({
      isAdmin: true,
      expiresIn: accessTTL,
      refreshToken,
      refreshExpiresIn: refreshTTL,
    });
  }

  // ── DB user path (email-based login for school operators) ──────────────────
  let user;
  try {
    const User = require('../models/userModel');
    user = await User.findOne({ email: loginId, isActive: true });
  } catch (err) {
    logger.error('[AuthController] DB lookup failed during login', { error: err.message });
    return res.status(503).json({ error: 'Authentication service unavailable.', code: 'AUTH_DB_ERROR' });
  }

  if (!user) {
    // Consume time to avoid user-enumeration via timing
    await bcrypt.compare(password || '', '$2a$10$dummyhashtopreventtimingattacks000000000000000000000000');
    recordLoginFailure(loginId).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  const credValid = Boolean(password) && await bcrypt.compare(password, user.passwordHash);
  if (!credValid) {
    recordLoginFailure(loginId).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  // ── MFA check: user-level TOTP first, school-level as fallback ─────────────
  // User-level MFA takes priority so each admin/owner has their own second factor
  // independent of whether the school has MFA configured.
  {
    const { verifyTotpCode, verifyBackupCode } = require('./mfaController');

    if (user.mfaEnabled && user.mfaSecret) {
      if (!mfaCode) {
        return res.status(200).json({ requiresMfa: true });
      }
      const totpValid = verifyTotpCode(user.mfaSecret, mfaCode);
      if (!totpValid) {
        const bcIdx = verifyBackupCode(user.mfaBackupCodes || [], mfaCode);
        if (bcIdx === -1) {
          recordLoginFailure(loginId).catch(() => {});
          return res.status(401).json({ error: 'Invalid MFA code.', code: 'INVALID_MFA_CODE' });
        }
        const User = require('../models/userModel');
        User.findByIdAndUpdate(user._id, { $set: { [`mfaBackupCodes.${bcIdx}.used`]: true } }).catch(() => {});
      }
    } else if (user.schoolId) {
      // Fall back to school-level TOTP when the user has no personal MFA enrolled
      const School = require('../models/schoolModel');
      let school;
      try {
        school = await School.findOne({ schoolId: user.schoolId, isActive: true });
      } catch {
        school = null;
      }

      if (school?.mfaEnabled && school.mfaSecret) {
        if (!mfaCode) {
          return res.status(200).json({ requiresMfa: true });
        }
        const totpValid = verifyTotpCode(school.mfaSecret, mfaCode);
        if (!totpValid) {
          const bcIdx = verifyBackupCode(school.mfaBackupCodes, mfaCode);
          if (bcIdx === -1) {
            recordLoginFailure(loginId).catch(() => {});
            return res.status(401).json({ error: 'Invalid MFA code.', code: 'INVALID_MFA_CODE' });
          }
          school.mfaBackupCodes[bcIdx].used = true;
          School.findOneAndUpdate(
            { schoolId: user.schoolId },
            { $set: { [`mfaBackupCodes.${bcIdx}.used`]: true } }
          ).catch(() => {});
        }
      }
    }
  }

  // ── Issue JWT for school user ──────────────────────────────────────────────
  clearLoginFailures(loginId);

  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  const token = jwt.sign(
    {
      role: 'user',
      userId: user._id.toString(),
      schoolId: user.schoolId,
      roles: user.roles,
    },
    secret,
    { expiresIn: accessTTL }
  );

  const refreshToken = crypto.randomBytes(40).toString('hex');
  getStore().set(refreshToken, refreshTTL).catch(() => {});

  res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

  return res.json({
    token,
    expiresIn: accessTTL,
    refreshToken,
    refreshExpiresIn: refreshTTL,
  });
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function handleRefresh(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required.', code: 'MISSING_REFRESH_TOKEN' });
  }

  const store = getStore();
  const valid = await store.has(refreshToken);
  if (!valid) {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return res.status(401).json({ error: 'Invalid or expired refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }

  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  const newRefreshToken = crypto.randomBytes(40).toString('hex');
  await store.set(newRefreshToken, refreshTTL);
  await store.del(refreshToken);

  const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: accessTTL });

  res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, newRefreshToken, refreshCookieOptions(refreshTTL));

  return res.json({
    token,
    expiresIn: accessTTL,
    refreshToken: newRefreshToken,
    refreshExpiresIn: refreshTTL,
  });
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function handleLogout(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (refreshToken) {
    await getStore().del(refreshToken);
  }

  const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_COOKIE_PATH });
  return res.json({ message: 'Logged out.' });
}

// ── Me ────────────────────────────────────────────────────────────────────────

function handleMe(req, res) {
  return res.json({ isAdmin: true });
}

module.exports = { handleLogin, handleRefresh, handleLogout, handleMe, _resetStore };
