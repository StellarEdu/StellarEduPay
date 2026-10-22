'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { get, set, del } = require('../cache');
const { sendAdminAlert } = require('../services/alertService');
const { maskEmail } = require('../utils/piiRedaction');
const { logAudit } = require('../services/auditService');
const {
  getStore,
  revokeAllUserSessions,
  parseTTL,
  _resetStore,
} = require('../services/sessionStore');

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

// ── Session revocation helper (#1772) ─────────────────────────────────────────
// Revokes all refresh tokens/families for a user and bumps their tokenVersion
// so any access token already issued is rejected by the auth middleware.
// Returns the new tokenVersion (or null when the user cannot be found).
async function revokeUserSessions(userId) {
  if (!userId) return null;

  const store = getStore();
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  try {
    await store.revokeAllUserTokens(userId, refreshTTL);
  } catch (err) {
    logger.warn('[AuthController] Failed to revoke user sessions', { userId, error: err.message });
  }

  // Bump tokenVersion so outstanding access tokens are invalidated immediately.
  let newVersion = null;
  try {
    const User = require('../models/userModel');
    const updated = await User.findByIdAndUpdate(
      userId,
      { $inc: { tokenVersion: 1 } },
      { new: true, projection: { tokenVersion: 1 } }
    );
    newVersion = updated?.tokenVersion ?? null;
  } catch (err) {
    logger.warn('[AuthController] Failed to bump tokenVersion', { userId, error: err.message });
  }

  return newVersion;
}

// ── Per-account login lockout ─────────────────────────────────────────────────

const LOGIN_FAIL_WINDOW = 900;
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_TTL = 900;

function loginLockKey(id) { return `loginLock:${id}`; }
function loginFailKey(id) { return `loginFail:${id}`; }

// Issue #1795 — a lock written to Redis by another replica must be honoured,
// so Redis is consulted in addition to the in-process cache.
async function isLockedOut(loginId) {
  if (get(loginLockKey(loginId))) return true;

  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    try {
      return (await redis.exists(loginLockKey(loginId))) === 1;
    } catch (e) {
      logger.warn('[AuthController] Redis error checking login lockout', { error: e.message });
    }
  }
  return false;
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
        // Mask loginId (email) in alert to prevent PII in logs
        await sendAdminAlert(`Login lockout triggered`, { loginId: maskEmail(loginId), failCount: count });
      }
    } catch (e) {
      logger.warn('[AuthController] Redis error tracking login failure', { error: e.message });
    }
  } else if (newCount >= LOGIN_FAIL_THRESHOLD) {
    set(lk, true, LOGIN_LOCK_TTL);
    // Mask loginId (email) in alert to prevent PII in logs
    await sendAdminAlert(`Login lockout triggered`, { loginId: maskEmail(loginId), failCount: newCount });
  }
}

function clearLoginFailures(loginId) {
  const fk = loginFailKey(loginId);
  const lk = loginLockKey(loginId);
  del(fk, lk);
  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    redis.del(fk, lk).catch(() => logger.debug('[AuthController] clearLoginFailures redis del missed'));
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

function extractDeviceInfo(req) {
  return {
    userAgent: req.headers?.['user-agent'] || null,
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

  if (await isLockedOut(loginId)) {
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
      recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid credentials)'));
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
    recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (no user)'));
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  const credValid = Boolean(password) && await bcrypt.compare(password, user.passwordHash);
  if (!credValid) {
    recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid credentials)'));
    return res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
  }

  // ── MFA check ──────────────────────────────────────────────────────────────
  let mfaSchool = null;
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
          recordLoginFailure(loginId).catch(() => logger.debug('[AuthController] recordLoginFailure missed (invalid MFA)'));
          return res.status(401).json({ error: 'Invalid MFA code.', code: 'INVALID_MFA_CODE' });
        }
        const User = require('../models/userModel');
        User.findByIdAndUpdate(user._id, { $set: { [`mfaBackupCodes.${bcIdx}.used`]: true } }).catch(() => logger.debug('[AuthController] mark user backup code used missed'));
      }
    } else if (user.schoolId) {
      // #1553 — The old shared-secret path (school.mfaSecret) is removed.
      // A single TOTP secret shared across all staff is a known-bad pattern:
      // departing employees retain a valid factor, backup codes are shared,
      // and MFA events cannot be attributed to an individual in the audit trail.
      //
      // Replacement: school.requireMfa is a POLICY flag. When true, users of
      // that school must have personal MFA enrolled. If they do not, the login
      // succeeds but they receive a restricted mfaSetupPending token that only
      // allows the /mfa/user/* setup endpoints — forcing enrolment before any
      // other action. The actual MFA challenge happens in the user.mfaEnabled
      // branch above once enrolment is complete.
      //
      // Legacy transition: we still read the school document so that the
      // mfaAlreadyEnabled check below can consider school.requireMfa, but we
      // no longer verify a TOTP code against a shared school secret.
      const School = require('../models/schoolModel');
      let school;
      try {
        school = await School.findOne({ schoolId: user.schoolId, isActive: true });
      } catch {
        school = null;
      }
      mfaSchool = school;
      // No TOTP challenge against a shared school secret — each user uses their
      // own per-user secret (handled in the user.mfaEnabled branch above).
    }
  }

  clearLoginFailures(loginId);

  const jwt = require('jsonwebtoken');
  const secret    = process.env.JWT_SECRET;
  const accessTTL  = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  // #1553 / #1356 — Determine whether MFA setup should be enforced.
  //
  // mfaSetupPending is true when EITHER:
  //   (a) the global REQUIRE_MFA env flag is set and the user has no personal MFA, OR
  //   (b) the user's school has requireMfa:true and the user has no personal MFA.
  //
  // In that case we issue a restricted token: the auth middleware only allows
  // it to reach the /mfa/user/* setup endpoints until the user enrolls their
  // own TOTP secret.  This closes the gap where a compromised password alone
  // grants full access.
  //
  // The old school.mfaEnabled / school.mfaSecret check is intentionally removed
  // (issue #1553). A shared school-level secret is no longer a valid MFA signal.
  const userHasPersonalMfa = Boolean(user.mfaEnabled && user.mfaSecret);
  const schoolRequiresMfa  = Boolean(mfaSchool?.requireMfa);
  const mfaAlreadyEnabled  = userHasPersonalMfa;
  const mfaSetupPending =
    (!mfaAlreadyEnabled) &&
    (process.env.REQUIRE_MFA === 'true' || schoolRequiresMfa);

  const jwtPayload = {
    role:     'user',
    userId:   user._id.toString(),
    schoolId: user.schoolId,
    roles:    user.roles,
    ...(mfaSetupPending ? { mfaSetupPending: true } : {}),
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

  return res.json({ expiresIn: accessTTL, refreshExpiresIn: refreshTTL, mfaSetupRequired: mfaSetupPending });
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
      await store.revokeFamily(consumedFamilyId, refreshTTL).catch(() => logger.debug('[AuthController] revokeFamily on reuse-detection missed'));
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
      .catch(() => logger.debug('[AuthController] session lastUsed update missed'));
  }

  // Reconstruct JWT payload from stored metadata so the refreshed token is
  // correct for every user type, not just the super-admin (#819).
  //
  // #1739 — Re-derive mfaSetupPending from the live User record instead of
  // copying it blindly from stored metadata. Without this, an admin who
  // completed MFA enrolment still gets a restricted token on every silent
  // refresh because the old metadata still contains mfaSetupPending:true,
  // sending them back to /mfa-setup indefinitely.
  //
  // For DB users (meta.userId is set and is not the env super-admin) we do a
  // lightweight lookup to check the current mfaEnabled + mfaSecret state and
  // the school's requireMfa policy, then compute the flag fresh. This also
  // picks up the role/schoolId changes addressed in #1528.
  const jwtPayload = {};
  if (meta.role)     jwtPayload.role     = meta.role;
  if (meta.userId)   jwtPayload.userId   = meta.userId;
  if (meta.roles)    jwtPayload.roles    = meta.roles;
  if (meta.schoolId) jwtPayload.schoolId = meta.schoolId;
  if (meta.username) jwtPayload.username = meta.username;

  // Re-derive mfaSetupPending for DB users only (super_admin has no User doc).
  if (meta.userId && meta.userId !== 'super_admin') {
    try {
      const User = require('../models/userModel');
      const liveUser = await User.findById(meta.userId).lean();

      if (!liveUser || !liveUser.isActive) {
        // Account was deleted or deactivated — refuse the refresh.
        res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
        return res.status(401).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
      }

      // Reflect any role / school changes made since the token was originally issued.
      if (liveUser.roles)    jwtPayload.roles    = liveUser.roles;
      if (liveUser.schoolId) jwtPayload.schoolId = liveUser.schoolId;

      // Re-evaluate MFA setup requirement against live state.
      const userHasPersonalMfa = Boolean(liveUser.mfaEnabled && liveUser.mfaSecret);
      let schoolRequiresMfa = false;
      if (liveUser.schoolId) {
        try {
          const School = require('../models/schoolModel');
          const liveSchool = await School.findOne({ schoolId: liveUser.schoolId, isActive: true }).lean();
          schoolRequiresMfa = Boolean(liveSchool?.requireMfa);
        } catch {
          // Non-fatal: fall back to false (more permissive is safer here).
        }
      }
      const mfaSetupPending =
        !userHasPersonalMfa &&
        (process.env.REQUIRE_MFA === 'true' || schoolRequiresMfa);

      if (mfaSetupPending) {
        jwtPayload.mfaSetupPending = true;
      }
      // If mfaSetupPending is false we deliberately omit it so the claim
      // disappears from the new token even if the old meta still had it.
    } catch (err) {
      // DB unavailable — fall back to trusting stored metadata so a transient
      // DB hiccup doesn't log everyone out. Log so it's visible in alerts.
      logger.warn('[AuthController] DB lookup failed during refresh; falling back to stored metadata', { error: err.message });
      if (meta.mfaSetupPending) jwtPayload.mfaSetupPending = meta.mfaSetupPending;
    }
  }

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
      await store.revokeFamily(meta.familyId, refreshTTL).catch(() => logger.debug('[AuthController] revokeFamily on logout missed'));
      if (meta.sessionId) await store.delSession(meta.sessionId).catch(() => logger.debug('[AuthController] delSession on logout missed'));
    }
    await store.delToken(refreshToken).catch(() => logger.debug('[AuthController] delToken on logout missed'));
  }

  const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_COOKIE_PATH });
  return res.json({ message: 'Logged out.' });
}

// ── Me ────────────────────────────────────────────────────────────────────────
// #1769 — /auth/me must work for every authenticated user (school owners,
// staff, read_only), not just the env super-admin. The frontend derives
// userId / schoolId / roles from this response, so gating it behind
// requireAdminAuth made the whole admin UI unreachable for school users.

function isSuperAdmin(principal) {
  if (!principal) return false;
  if (principal.userId === 'super_admin') return true;
  if (principal.role === 'admin') return true;
  return Array.isArray(principal.roles) && principal.roles.includes('super_admin');
}

function handleMe(req, res) {
  // req.user is populated by requireSchoolAuth; fall back to req.admin for
  // any route still using the legacy guard.
  const p = req.user || req.admin || {};
  const roles = Array.isArray(p.roles) ? p.roles : (p.role ? [p.role] : []);
  return res.json({
    userId:          p.userId || p.sub || null,
    email:           p.email || p.username || null,
    schoolId:        p.schoolId || null,
    roles,
    mfaEnabled:      Boolean(p.mfaEnabled),
    mfaSetupPending: Boolean(p.mfaSetupPending),
    exp:             p.exp || null,
  });
}

// ── Session management ────────────────────────────────────────────────────────
// #1769 — Sessions are scoped to the caller. Super-admins may list/revoke any
// session; everyone else only sees and revokes their own.

async function handleListSessions(req, res) {
  const principal = req.user || req.admin || {};
  const userId = principal.userId || 'super_admin';
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
  const principal = req.user || req.admin || {};
  const store = getStore();
  const sess = await store.getSession(sessionId).catch(() => null);
  if (!sess) {
    return res.status(404).json({ error: 'Session not found.', code: 'SESSION_NOT_FOUND' });
  }
  // #1769 — Ownership check: a caller may only revoke their own sessions
  // unless they are a super-admin.
  if (!isSuperAdmin(principal) && sess.userId !== principal.userId) {
    return res.status(403).json({
      error: 'You may only revoke your own sessions.',
      code: 'FORBIDDEN',
    });
  }
  if (sess.familyId) {
    const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);
    await store.revokeFamily(sess.familyId, refreshTTL).catch(() => logger.debug('[AuthController] revokeFamily in handleRevokeSession missed'));
  }
  await store.delSession(sessionId).catch(() => logger.debug('[AuthController] delSession in handleRevokeSession missed'));
  await logAudit({
    schoolId: principal.schoolId || 'system',
    action: 'SESSION_REVOKED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: sessionId,
    targetType: 'session',
    details: { revokedFamilyId: sess.familyId || null },
  });
  return res.json({ message: 'Session revoked.' });
}

// ── Change Password ───────────────────────────────────────────────────────────
// #1360 — Invalidate ALL existing refresh tokens and sessions for the user
// when their password changes so that a stolen refresh token cannot be used
// to continue obtaining access tokens after a password reset.

async function handleChangePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: 'currentPassword and newPassword are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: 'New password must be at least 8 characters.',
      code: 'VALIDATION_ERROR',
    });
  }

  const userId = req.admin?.userId;

  // Super-admin (env-based) path
  if (!userId || userId === 'super_admin') {
    return res.status(403).json({
      error: 'Super-admin password must be changed via environment variables.',
      code: 'FORBIDDEN',
    });
  }

  let user;
  try {
    const User = require('../models/userModel');
    user = await User.findById(userId);
  } catch (err) {
    logger.error('[AuthController] DB lookup failed during password change', { error: err.message });
    return res.status(503).json({ error: 'Service unavailable.', code: 'AUTH_DB_ERROR' });
  }

  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  const currentValid = Boolean(currentPassword) && await bcrypt.compare(currentPassword, user.passwordHash);
  if (!currentValid) {
    return res.status(401).json({ error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  try {
    const User = require('../models/userModel');
    await User.findByIdAndUpdate(userId, { $set: { passwordHash: newHash } });
  } catch (err) {
    logger.error('[AuthController] Failed to update password hash', { error: err.message });
    return res.status(500).json({ error: 'Failed to update password.', code: 'DB_ERROR' });
  }

  // #1360 — Revoke ALL active sessions and their refresh token families so
  // any stolen refresh token is immediately invalidated after a password change.
  try {
    const count = await revokeAllUserSessions(userId);
    logger.info('[AuthController] All sessions revoked after password change', { userId, count });
  } catch (err) {
    // Non-fatal: password is already updated; log and continue.
    logger.warn('[AuthController] Failed to revoke sessions after password change', { userId, error: err.message });
  }

  // Clear the caller's own cookies — they must log in again with the new password.
  const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_COOKIE_PATH });

  await logAudit({
    schoolId: req.admin?.schoolId || req.user?.schoolId || 'system',
    action: 'PASSWORD_CHANGED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: String(userId),
    targetType: 'user',
    details: { sessionsRevoked: true },
  });

  return res.json({ message: 'Password changed. All sessions have been invalidated. Please log in again.' });
}

module.exports = {
  handleLogin,
  handleRefresh,
  handleLogout,
  handleMe,
  handleListSessions,
  handleRevokeSession,
  handleChangePassword,
  revokeUserSessions,
  // Re-exported from services/sessionStore so callers (e.g. userController)
  // can revoke sessions without optional chaining that silently no-ops.
  getStore,
  revokeAllUserSessions,
  parseTTL,
  _resetStore,
  // Exported for use in mfaController and userController
  issueRefreshToken,
  isLockedOut,
  isSuperAdmin,
};
