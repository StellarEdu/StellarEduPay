'use strict';

/**
 * Shared session/token store.
 *
 * Historically the in-memory store lived inside `authController` and other
 * controllers tried to reach it via `require('./authController').getStore`,
 * which was never exported. That optional-chained call silently returned
 * `undefined`, so password resets (and other flows) never revoked sessions.
 *
 * This module is the single source of truth for the store so that every
 * controller can import it directly and revocation actually happens.
 *
 * The method names returned by `getStore()` are the contract the auth
 * controllers and user/MFA flows already call (setToken, getToken, markConsumed,
 * revokeFamily, setSession, getSession, delSession, listUserSessions, ...).
 */

const { parseTTL } = require('../utils/ttl');

// userId -> Map<sessionId, session>
const sessions = new Map();
// refreshToken -> { userId, sessionId, familyId, expiresAt, ... }
const refreshTokens = new Map();
// familyId -> Set<refreshToken>
const families = new Map();
// familyId -> expiresAt (ms) — families whose refresh tokens were revoked
const revokedFamilies = new Map();
// consumed (rotated-away) refreshToken -> { familyId, expiresAt } for reuse detection
const consumedTokens = new Map();

function now() {
  return Date.now();
}

function expiryFromTTL(ttlSeconds) {
  return now() + Number(ttlSeconds) * 1000;
}

function isExpired(entry) {
  return !entry || (typeof entry.expiresAt === 'number' && entry.expiresAt <= now());
}

function userKey(userId) {
  return userId === null || userId === undefined ? 'anonymous' : String(userId);
}

function getUserSessions(userId) {
  return sessions.get(userKey(userId)) || new Map();
}

// Sessions are indexed per user, but the controllers address them by sessionId
// alone (logout, revoke-by-id), so look the session up across users.
function findSession(sessionId) {
  if (!sessionId) return null;
  for (const userSessions of sessions.values()) {
    const sess = userSessions.get(sessionId);
    if (sess) return { userSessions, sess };
  }
  return null;
}

function getStore() {
  return {
    sessions,
    refreshTokens,
    families,

    getUserSessions,

    // ── Refresh tokens ──────────────────────────────────────────────────────

    async setToken(token, ttlSeconds, meta) {
      // expiresAt is set last so a spread of previous metadata (rotation) cannot
      // carry over a stale expiry.
      const entry = { ...meta, expiresAt: expiryFromTTL(ttlSeconds) };
      refreshTokens.set(token, entry);
      if (entry.familyId) {
        if (!families.has(entry.familyId)) families.set(entry.familyId, new Set());
        families.get(entry.familyId).add(token);
      }
      return entry;
    },

    async getToken(token) {
      const entry = refreshTokens.get(token);
      if (isExpired(entry)) {
        if (entry) refreshTokens.delete(token);
        return null;
      }
      return entry;
    },

    async delToken(token) {
      const entry = refreshTokens.get(token);
      refreshTokens.delete(token);
      if (entry && entry.familyId && families.has(entry.familyId)) {
        const family = families.get(entry.familyId);
        family.delete(token);
        if (family.size === 0) families.delete(entry.familyId);
      }
      return entry || null;
    },

    async markConsumed(token, familyId, ttlSeconds) {
      consumedTokens.set(token, { familyId, expiresAt: expiryFromTTL(ttlSeconds) });
    },

    async getConsumedFamily(token) {
      const entry = consumedTokens.get(token);
      if (isExpired(entry)) {
        if (entry) consumedTokens.delete(token);
        return null;
      }
      return entry.familyId;
    },

    // Revoke every refresh token in a family and remember the family as revoked
    // so a later refresh with a still-valid copy is rejected.
    async revokeFamily(familyId, ttlSeconds) {
      if (!familyId) return 0;
      revokedFamilies.set(familyId, expiryFromTTL(ttlSeconds || parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400)));
      const family = families.get(familyId);
      if (!family) return 0;
      let revoked = 0;
      for (const token of Array.from(family)) {
        if (refreshTokens.delete(token)) revoked += 1;
      }
      families.delete(familyId);
      return revoked;
    },

    async isFamilyRevoked(familyId) {
      if (!familyId) return false;
      const expiresAt = revokedFamilies.get(familyId);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        revokedFamilies.delete(familyId);
        return false;
      }
      return true;
    },

    async revokeAllUserTokens(userId, ttlSeconds) {
      const key = userKey(userId);
      const familyIds = new Set();
      let revoked = 0;
      for (const [token, entry] of Array.from(refreshTokens.entries())) {
        if (entry && userKey(entry.userId) === key) {
          if (entry.familyId) familyIds.add(entry.familyId);
          refreshTokens.delete(token);
          revoked += 1;
        }
      }
      for (const familyId of familyIds) {
        revokedFamilies.set(familyId, expiryFromTTL(ttlSeconds || parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400)));
        families.delete(familyId);
      }
      return revoked;
    },

    // ── Sessions ────────────────────────────────────────────────────────────

    async setSession(sessionId, session, ttlSeconds) {
      const key = userKey(session.userId);
      if (!sessions.has(key)) sessions.set(key, new Map());
      const entry = { ...session, sessionId, expiresAt: expiryFromTTL(ttlSeconds || parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400)) };
      sessions.get(key).set(sessionId, entry);
      return entry;
    },

    async getSession(sessionId) {
      const found = findSession(sessionId);
      if (!found) return null;
      if (isExpired(found.sess)) {
        found.userSessions.delete(sessionId);
        return null;
      }
      return found.sess;
    },

    async delSession(sessionId) {
      const found = findSession(sessionId);
      if (!found) return false;
      return found.userSessions.delete(sessionId);
    },

    async listUserSessions(userId) {
      return Array.from(getUserSessions(userId).values()).filter((s) => !isExpired(s));
    },

    async clear() {
      sessions.clear();
      refreshTokens.clear();
      families.clear();
      revokedFamilies.clear();
      consumedTokens.clear();
    },
  };
}

/**
 * Revoke every session and refresh-token family belonging to a user.
 *
 * Used by password reset, password change, user deactivation/deletion and
 * MFA disable so that pre-existing credentials stop working immediately.
 *
 * @param {string|number} userId
 * @returns {{ sessions: number, refreshTokens: number }}
 */
function revokeAllUserSessions(userId) {
  const store = getStore();
  const revokedTokens = store.revokeAllUserTokens(userId, parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400));

  // Delete all sessions for the user.
  const key = userKey(userId);
  const userSessions = sessions.get(key);
  const sessionCount = userSessions ? userSessions.size : 0;
  sessions.delete(key);

  // Best-effort: clear login lockout counters if the auth controller exposes
  // them. Wrapped in try/catch so a missing helper never breaks revocation.
  try {
    // eslint-disable-next-line global-require
    const authController = require('../controllers/authController');
    if (authController && typeof authController.clearLoginAttempts === 'function') {
      authController.clearLoginAttempts(userId);
    }
  } catch (err) {
    // ignore — lockout clearing is optional
  }

  return { sessions: sessionCount, refreshTokens: revokedTokens };
}

/** Test helper: wipe every in-memory session/token structure. */
function _resetStore() {
  getStore().clear();
}

module.exports = {
  getStore,
  revokeAllUserSessions,
  parseTTL,
  _resetStore,
};
