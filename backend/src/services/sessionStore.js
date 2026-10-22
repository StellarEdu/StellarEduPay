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
 */

const { parseTTL } = require('../utils/ttl');

// userId -> Map<sessionId, session>
const sessions = new Map();
// refreshToken -> { userId, sessionId, familyId, expiresAt }
const refreshTokens = new Map();
// familyId -> Set<refreshToken>
const families = new Map();

function now() {
  return Date.now();
}

function isExpired(entry) {
  return !entry || (typeof entry.expiresAt === 'number' && entry.expiresAt <= now());
}

function getUserSessions(userId) {
  return sessions.get(String(userId)) || new Map();
}

function getStore() {
  return {
    sessions,
    refreshTokens,
    families,

    getUserSessions,

    getSession(userId, sessionId) {
      const userSessions = getUserSessions(userId);
      return userSessions.get(sessionId) || null;
    },

    setSession(userId, sessionId, session) {
      const key = String(userId);
      if (!sessions.has(key)) sessions.set(key, new Map());
      sessions.get(key).set(sessionId, session);
      return session;
    },

    deleteSession(userId, sessionId) {
      const userSessions = sessions.get(String(userId));
      if (!userSessions) return false;
      return userSessions.delete(sessionId);
    },

    listSessions(userId) {
      return Array.from(getUserSessions(userId).values());
    },

    setRefreshToken(token, entry) {
      refreshTokens.set(token, entry);
      if (entry && entry.familyId) {
        if (!families.has(entry.familyId)) families.set(entry.familyId, new Set());
        families.get(entry.familyId).add(token);
      }
      return entry;
    },

    getRefreshToken(token) {
      const entry = refreshTokens.get(token);
      if (isExpired(entry)) {
        if (entry) refreshTokens.delete(token);
        return null;
      }
      return entry || null;
    },

    deleteRefreshToken(token) {
      const entry = refreshTokens.get(token);
      refreshTokens.delete(token);
      if (entry && entry.familyId && families.has(entry.familyId)) {
        const family = families.get(entry.familyId);
        family.delete(token);
        if (family.size === 0) families.delete(entry.familyId);
      }
      return entry || null;
    },

    revokeFamily(familyId) {
      const family = families.get(familyId);
      if (!family) return 0;
      let revoked = 0;
      for (const token of Array.from(family)) {
        if (refreshTokens.delete(token)) revoked += 1;
      }
      families.delete(familyId);
      return revoked;
    },

    clear() {
      sessions.clear();
      refreshTokens.clear();
      families.clear();
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
  const key = String(userId);
  const store = getStore();
  let revokedTokens = 0;

  // Revoke every refresh-token family that belongs to this user.
  const familyIds = new Set();
  for (const [token, entry] of Array.from(refreshTokens.entries())) {
    if (entry && String(entry.userId) === key) {
      if (entry.familyId) familyIds.add(entry.familyId);
      refreshTokens.delete(token);
      revokedTokens += 1;
    }
  }
  for (const familyId of familyIds) {
    families.delete(familyId);
  }

  // Delete all sessions for the user.
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

module.exports = {
  getStore,
  revokeAllUserSessions,
  parseTTL,
};