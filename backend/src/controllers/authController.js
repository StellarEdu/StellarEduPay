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

// ── Token & session store ─────────────────────────────────────────────────────
// Redis keys:
//   refresh:token:<token>    → JSON metadata ({ familyId, sessionId, userId, role, ... })
//   refresh:consumed:<token> → familyId string (300s reuse-detection window)
//   refresh:revoked:<fid>    → '1' (TTL: refresh token max TTL)
//   session:<sid>            → JSON session record
//   sessions:user:<uid>      → Redis set of active sessionIds

function makeRedisStore(client) {
  return {
    async setToken(token, ttlSeconds, meta) {
      await client.set(`refresh:token:${token}`, JSON.stringify(meta), 'EX', ttlSeconds);
    },
    async getToken(token) {
      const raw = await client.get(`refresh:token:${token}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async delToken(token) {
      await client.del(`refresh:token:${token}`);
    },
    async markConsumed(token, familyId, ttlSeconds = 300) {
      await client.set(`refresh:consumed:${token}`, familyId, 'EX', ttlSeconds);
    },
    async getConsumedFamily(token) {
      return client.get(`refresh:consumed:${token}`);
    },
    async revokeFamily(familyId, ttlSeconds) {
      await client.set(`refresh:revoked:${familyId}`, '1', 'EX', ttlSeconds);
    },
    async isFamilyRevoked(familyId) {
      return (await client.exists(`refresh:revoked:${familyId}`)) === 1;
    },
    async setSession(sessionId, data, ttlSeconds) {
      await client.set(`session:${sessionId}`, JSON.stringify(data), 'EX', ttlSeconds);
      if (data.userId) {
        await client.sadd(`sessions:user:${data.userId}`, sessionId);
        await client.expire(`sessions:user:${data.userId}`, ttlSeconds);
      }
    },
    async getSession(sessionId) {
      const raw = await client.get(`session:${sessionId}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async delSession(sessionId) {
      const raw = await client.get(`session:${sessionId}`);
      if (raw) {
        try {
          const data = JSON.parse(raw);
          if (data.userId) await client.srem(`sessions:user:${data.userId}`, sessionId);
        } catch {}
      }
      await client.del(`session:${sessionId}`);
    },
    async listUserSessions(userId) {
      const ids = await client.smembers(`sessions:user:${userId}`);
      const result = [];
      for (const id of ids) {
        const sess = await this.getSession(id);
        if (sess) result.push({ sessionId: id, ...sess });
        else await client.srem(`sessions:user:${userId}`, id);
      }
      return result;
    },
  };
}

function makeMemoryStore() {
  const tokens = new Map();
  const consumed = new Map();
  const revoked = new Map();
  const sessions = new Map();
  const userSessions = new Map();

  function alive(entry) { return entry && Date.now() < entry.exp; }

  return {
    async setToken(token, ttlSeconds, meta) {
      tokens.set(token, { meta, exp: Date.now() + ttlSeconds * 1000 });
    },
    async getToken(token) {
      const e = tokens.get(token);
      if (!alive(e)) { tokens.delete(token); return null; }
      return e.meta;
    },
    async delToken(token) { tokens.delete(token); },
    async markConsumed(token, familyId, ttlSeconds = 300) {
      consumed.set(token, { familyId, exp: Date.now() + ttlSeconds * 1000 });
    },
    async getConsumedFamily(token) {
      const e = consumed.get(token);
      if (!alive(e)) { consumed.delete(token); return null; }
      return e.familyId;
    },
    async revokeFamily(familyId, ttlSeconds) {
      revoked.set(familyId, Date.now() + ttlSeconds * 1000);
    },
    async isFamilyRevoked(familyId) {
      const exp = revoked.get(familyId);
      if (!exp) return false;
      if (Date.now() > exp) { revoked.delete(familyId); return false; }
      return true;
    },
    async setSession(sessionId, data, ttlSeconds) {
      sessions.set(sessionId, { data, exp: Date.now() + ttlSeconds * 1000 });
      if (data.userId) {
        if (!userSessions.has(data.userId)) userSessions.set(data.userId, new Set());
        userSessions.get(data.userId).add(sessionId);
      }
    },
    async getSession(sessionId) {
      const e = sessions.get(sessionId);
      if (!alive(e)) { sessions.delete(sessionId); return null; }
      return e.data;
    },
    async delSession(sessionId) {
      const e = sessions.get(sessionId);
      if (e?.data?.userId) userSessions.get(e.data.userId)?.delete(sessionId);
      sessions.delete(sessionId);
    },
    async listUserSessions(userId) {
      const ids = userSessions.get(userId) || new Set();
      const result = [];
      for (const id of [...ids]) {
        const sess = await this.getSession(id);
        if (sess) result.push({ sessionId: id, ...sess });
        else ids.delete(id);
      }
      return result;
    },
  };
}

let _store;

function getStore() {
  if (_store) return _store;

  if (process.env.REDIS_HOST) {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      _store = makeRedisStore(client);
      return _store;
    }
    logger.warn('[AuthController] Redis unavailable — falling back to in-memory token store');
  }

  _store = makeMemoryStore();
  return _store;
}

function _resetStore() { _store = null; }

// ── Per-account login lockout ─────────────────────────────────────────────────

const LOGIN_FAIL_WINDOW = 900;
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_TTL = 900;

function loginLockKey(id) { return `loginLock:${id}`; }
function loginFailKey(id) { return `loginFail:${id}`; }

function isLockedOut(loginId) {
  return Boolean(get(loginLockKey(loginId)));
}

async function recordLoginFailure(loginId) {
  const fk = loginFailKey(loginId);
  const lk = loginLockKey(loginId);

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
        set(lk, true, LOGIN_LOCK_TTL);
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

function extractDeviceInfo(req) {
  return {
    userAgent: req.headers['user-agent'] || null,
    ip: req.ip || req.connection?.remoteAddress || null,
  };
}

// Persist a refresh token and create a session record. Returns the generated
// refreshToken string. Throws on store write failure (#820).
async function issueRefreshToken(store, jwtPayload, refreshTTL, req) {
  const familyId  = crypto.randomBytes(16).toString('hex');
  const sessionId = crypto.randomBytes(16).toString('hex');
  const refreshToken = crypto.randomBytes(40).toString('hex');

  await store.setToken(refreshToken, refreshTTL, { familyId, sessionId, ...jwtPayload });

  store.setSession(sessionId, {
    userId:     jwtPayload.userId   || null,
    role:       jwtPayload.role     || null,
    roles:      jwtPayload.roles    || [],
    schoolId:   jwtPayload.schoolId || null,
    familyId,
    deviceInfo: extractDeviceInfo(req),
    createdAt:  new Date().toISOString(),
    lastUsed:   new Date().toISOString(),
  }, refreshTTL).catch(err =>
    logger.warn('[AuthController] Failed to persist session record', { error: err.message })
  );

  return refreshToken;
}

// ── Login handler ─────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
  const { username, email, password, mfaCode } = req.body || {};
  const loginId = ((email || username) || '').trim().toLowerCase();

  if (isLockedOut(loginId)) {
    return res.status(429).json({
      error: 'Too many failed login attempts. Account temporarily locked.',
      code: 'ACCOUNT_LOCKED',
    });
  }

  // ── ENV super-admin path ───────────────────────────────────────────────────
  if (!email) {
    const envUsername     = process.env.ADMIN_USERNAME;
    const envPasswordHash = process.env.ADMIN_PASSWORD_HASH;
    const envPassword     = process.env.ADMIN_PASSWORD;

    if (!envUsername || (!envPassword && !envPasswordHash)) {
      return res.status(500).json({
        error: 'Server misconfiguration: ADMIN_USERNAME or ADMIN_PASSWORD is not set.',
        code: 'AUTH_MISCONFIGURED',
      });
    }

    const usernameMatch = loginId ? safeEqual(loginId, envUsername) : false;
    let credValid = false;

    if (envPasswordHash) {
      credValid = usernameMatch && Boolean(password) && await bcrypt.compare(password, envPasswordHash);
    } else {
      credValid = usernameMatch && Boolean(password) && safeEqual(password, envPassword);
    }

    if (!credValid) {
      recordLoginFailure(loginId).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
    }

    clearLoginFailures(loginId);

    const jwt = require('jsonwebtoken');
    const secret    = process.env.JWT_SECRET;
    const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

    const jwtPayload = { role: 'admin', username: loginId, userId: 'super_admin', roles: ['super_admin'] };
    const token = jwt.sign(jwtPayload, secret, { expiresIn: accessTTL });

    const store = getStore();
    let refreshToken;
    try {
      refreshToken = await issueRefreshToken(store, jwtPayload, refreshTTL, req);
    } catch (err) {
      logger.error('[AuthController] Failed to persist refresh token during login', { error: err.message });
      return res.status(500).json({ error: 'Authentication service unavailable.', code: 'TOKEN_STORE_ERROR' });
    }

    // Deliver tokens via httpOnly cookies only — no tokens in response body (#821)
    res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

    return res.json({ isAdmin: true, expiresIn: accessTTL, refreshExpiresIn: refreshTTL });
  }

  // ── DB user path ───────────────────────────────────────────────────────────
  let user;
  try {
    const User = require('../models/userModel');
    user = await User.findOne({ email: loginId, isActive: true });
  } catch (err) {
    logger.error('[AuthController] DB lookup failed during login', { error: err.message });
    return res.status(503).json({ error: 'Authentication service unavailable.', code: 'AUTH_DB_ERROR' });
  }

  if (!user) {
    await bcrypt.compare(password || '', '$2a$10$dummyhashtopreventtimingattacks000000000000000000000000');
    recordLoginFailure(loginId).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  const credValid = Boolean(password) && await bcrypt.compare(password, user.passwordHash);
  if (!credValid) {
    recordLoginFailure(loginId).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  // ── MFA check ──────────────────────────────────────────────────────────────
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

  clearLoginFailures(loginId);

  const jwt = require('jsonwebtoken');
  const secret    = process.env.JWT_SECRET;
  const accessTTL  = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  const jwtPayload = {
    role:     'user',
    userId:   user._id.toString(),
    schoolId: user.schoolId,
    roles:    user.roles,
  };
  const token = jwt.sign(jwtPayload, secret, { expiresIn: accessTTL });

  const store = getStore();
  let refreshToken;
  try {
    refreshToken = await issueRefreshToken(store, jwtPayload, refreshTTL, req);
  } catch (err) {
    logger.error('[AuthController] Failed to persist refresh token during login', { error: err.message });
    return res.status(500).json({ error: 'Authentication service unavailable.', code: 'TOKEN_STORE_ERROR' });
  }

  // Deliver tokens via httpOnly cookies only — no tokens in response body (#821)
  res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

  return res.json({ expiresIn: accessTTL, refreshExpiresIn: refreshTTL });
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function handleRefresh(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required.', code: 'MISSING_REFRESH_TOKEN' });
  }

  const store = getStore();
  const meta = await store.getToken(refreshToken);

  if (!meta) {
    // Reuse detection: check if this token was recently consumed (#819)
    const consumedFamilyId = await store.getConsumedFamily(refreshToken);
    if (consumedFamilyId) {
      logger.warn('[AuthController] Refresh token reuse detected — revoking family', { familyId: consumedFamilyId });
      const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
      await store.revokeFamily(consumedFamilyId, refreshTTL).catch(() => {});
    }
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return res.status(401).json({ error: 'Invalid or expired refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }

  // Reject if the whole token family has been revoked (#819)
  if (!meta.familyId || await store.isFamilyRevoked(meta.familyId)) {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return res.status(401).json({ error: 'Session has been revoked.', code: 'SESSION_REVOKED' });
  }

  const jwt = require('jsonwebtoken');
  const secret     = process.env.JWT_SECRET;
  const accessTTL  = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  const newRefreshToken = crypto.randomBytes(40).toString('hex');

  // Mark old token consumed before issuing the new one (#819)
  await store.markConsumed(refreshToken, meta.familyId, 300);
  await store.delToken(refreshToken);

  try {
    await store.setToken(newRefreshToken, refreshTTL, { ...meta, issuedAt: new Date().toISOString() });
  } catch (err) {
    logger.error('[AuthController] Failed to persist rotated refresh token', { error: err.message });
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return res.status(500).json({ error: 'Authentication service unavailable.', code: 'TOKEN_STORE_ERROR' });
  }

  // Update session lastUsed (non-critical)
  if (meta.sessionId) {
    store.getSession(meta.sessionId)
      .then(sess => sess && store.setSession(meta.sessionId, { ...sess, lastUsed: new Date().toISOString() }, refreshTTL))
      .catch(() => {});
  }

  // Reconstruct JWT payload from stored metadata so the refreshed token is
  // correct for every user type, not just the super-admin (#819)
  const jwtPayload = {};
  if (meta.role)     jwtPayload.role     = meta.role;
  if (meta.userId)   jwtPayload.userId   = meta.userId;
  if (meta.roles)    jwtPayload.roles    = meta.roles;
  if (meta.schoolId) jwtPayload.schoolId = meta.schoolId;
  if (meta.username) jwtPayload.username = meta.username;

  const accessToken = jwt.sign(jwtPayload, secret, { expiresIn: accessTTL });

  // Deliver via cookies only — no tokens in response body (#821)
  res.cookie(ACCESS_COOKIE, accessToken, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, newRefreshToken, refreshCookieOptions(refreshTTL));

  return res.json({ expiresIn: accessTTL, refreshExpiresIn: refreshTTL });
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function handleLogout(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (refreshToken) {
    const store = getStore();
    const meta = await store.getToken(refreshToken).catch(() => null);
    if (meta?.familyId) {
      // Revoke the whole family so any rotated copies are also invalidated
      const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
      await store.revokeFamily(meta.familyId, refreshTTL).catch(() => {});
      if (meta.sessionId) await store.delSession(meta.sessionId).catch(() => {});
    }
    await store.delToken(refreshToken).catch(() => {});
  }

  const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_COOKIE_PATH });
  return res.json({ message: 'Logged out.' });
}

// ── Me ────────────────────────────────────────────────────────────────────────

function handleMe(req, res) {
  const p = req.admin;
  return res.json({
    userId:   p.userId   || p.sub || null,
    schoolId: p.schoolId || null,
    roles:    Array.isArray(p.roles) ? p.roles : (p.role ? [p.role] : []),
    exp:      p.exp      || null,
  });
}

// ── Session management (admin) ────────────────────────────────────────────────

async function handleListSessions(req, res) {
  const userId = req.admin?.userId || 'super_admin';
  try {
    const sessions = await getStore().listUserSessions(userId);
    return res.json({ sessions });
  } catch (err) {
    logger.error('[AuthController] Failed to list sessions', { error: err.message });
    return res.status(500).json({ error: 'Failed to list sessions.', code: 'SESSION_LIST_ERROR' });
  }
}

async function handleRevokeSession(req, res) {
  const { sessionId } = req.params;
  const store = getStore();
  const sess = await store.getSession(sessionId).catch(() => null);
  if (!sess) {
    return res.status(404).json({ error: 'Session not found.', code: 'SESSION_NOT_FOUND' });
  }
  if (sess.familyId) {
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
    await store.revokeFamily(sess.familyId, refreshTTL).catch(() => {});
  }
  await store.delSession(sessionId).catch(() => {});
  return res.json({ message: 'Session revoked.' });
}

module.exports = {
  handleLogin,
  handleRefresh,
  handleLogout,
  handleMe,
  handleListSessions,
  handleRevokeSession,
  _resetStore,
};
