'use strict';

/**
 * Refresh-token and session store (issue #1921).
 *
 * This module is the ONLY place that defines the token/session store
 * interface. Controllers (authController, mfaController, userController) talk
 * to whatever `getStore()` returns and never to a backend directly.
 *
 * Interface — every method returns a Promise:
 *
 *   setToken(token, ttlSeconds, meta)           store refresh-token metadata
 *   getToken(token)                             metadata object, or null
 *   delToken(token)
 *   markConsumed(token, familyId, ttlSeconds)   reuse-detection window (default 300s)
 *   getConsumedFamily(token)                    familyId, or null
 *   revokeFamily(familyId, ttlSeconds)          revoke every token in a family
 *   isFamilyRevoked(familyId)                   boolean
 *   setSession(sessionId, data, ttlSeconds)     session record, indexed by data.userId
 *   getSession(sessionId)                       session record, or null
 *   delSession(sessionId)
 *   listUserSessions(userId)                    [{ sessionId, ...session }]
 *   revokeAllUserTokens(userId, ttlSeconds)     { families, sessions } revoked counts
 *
 * Backends
 *   - Redis (when REDIS_HOST is set and the client is ready). Shared by every
 *     replica, so a token issued by pod A is accepted by pod B.
 *   - In-memory (when REDIS_HOST is not set, or in non-production while Redis
 *     is temporarily down). Process-local: suitable for tests and single-node dev.
 *
 * Production never silently runs per-process: when REDIS_HOST is set but Redis
 * is not ready, getStore() returns a store whose every call fails with
 * TokenStoreUnavailableError (mapped to HTTP 503), and assertTokenStoreReady()
 * makes startup fail.
 */

const { parseTTL } = require('../utils/ttl');
const logger = require('../utils/logger');
const { getRedisClient } = require('../config/redisClient');

const DEFAULT_REFRESH_TTL = 30 * 86400;
const DEFAULT_CONSUMED_TTL = 300;

class TokenStoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message || 'Token store unavailable');
    this.name = 'TokenStoreUnavailableError';
    this.code = 'TOKEN_STORE_UNAVAILABLE';
    if (cause) this.cause = cause;
  }
}

// ── Key layout (shared by both backends) ──────────────────────────────────────

const KEY = {
  token:        (t) => `refresh:token:${t}`,
  consumed:     (t) => `refresh:consumed:${t}`,
  revoked:      (f) => `refresh:revoked:${f}`,
  userFamilies: (u) => `refresh:user:${u}:families`,
  session:      (s) => `session:${s}`,
  userSessions: (u) => `sessions:user:${u}`,
};

// ── Adapters ──────────────────────────────────────────────────────────────────
// An adapter exposes a tiny ioredis-compatible subset:
//   get(key) → string|null          set(key, value, ttlSeconds)
//   del(key)                        exists(key) → 0|1
//   sadd(key, member)               srem(key, member)
//   smembers(key) → string[]        expire(key, ttlSeconds)
// Every adapter error is rethrown as TokenStoreUnavailableError by the store.

function makeRedisAdapter(client) {
  return {
    get: (key) => client.get(key),
    set: (key, value, ttl) => client.set(key, value, 'EX', ttl),
    del: (key) => client.del(key),
    exists: (key) => client.exists(key),
    sadd: (key, member) => client.sadd(key, member),
    srem: (key, member) => client.srem(key, member),
    smembers: (key) => client.smembers(key),
    expire: (key, ttl) => client.expire(key, ttl),
  };
}

function makeMemoryAdapter() {
  const values = new Map(); // key -> { value, exp }
  const sets = new Map();   // key -> { members: Set<string>, exp }
  const now = () => Date.now();

  function liveValue(key) {
    const entry = values.get(key);
    if (!entry) return null;
    if (entry.exp <= now()) { values.delete(key); return null; }
    return entry;
  }
  function liveSet(key) {
    const entry = sets.get(key);
    if (!entry) return null;
    if (entry.exp <= now()) { sets.delete(key); return null; }
    return entry;
  }

  return {
    async get(key) {
      const entry = liveValue(key);
      return entry ? entry.value : null;
    },
    async set(key, value, ttl) {
      values.set(key, { value: String(value), exp: now() + ttl * 1000 });
      return 'OK';
    },
    async del(key) {
      const existed = liveValue(key) !== null;
      values.delete(key);
      const hadSet = liveSet(key) !== null;
      sets.delete(key);
      return existed || hadSet ? 1 : 0;
    },
    async exists(key) {
      return liveValue(key) !== null || liveSet(key) !== null ? 1 : 0;
    },
    async sadd(key, member) {
      let entry = liveSet(key);
      if (!entry) {
        // Infinity until expire() sets the real TTL, so a concurrent read in
        // the same millisecond cannot treat the fresh set as already expired.
        entry = { members: new Set(), exp: Number.POSITIVE_INFINITY };
        sets.set(key, entry);
      }
      const before = entry.members.size;
      entry.members.add(String(member));
      return entry.members.size - before;
    },
    async srem(key, member) {
      const entry = liveSet(key);
      if (!entry) return 0;
      return entry.members.delete(String(member)) ? 1 : 0;
    },
    async smembers(key) {
      const entry = liveSet(key);
      return entry ? Array.from(entry.members) : [];
    },
    async expire(key, ttl) {
      const entry = liveSet(key) || liveValue(key);
      if (!entry) return 0;
      entry.exp = now() + ttl * 1000;
      return 1;
    },
  };
}

// ── The store (written once, over any adapter) ────────────────────────────────

function createTokenStore(adapter, backend) {
  const parse = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };

  // Wrap every adapter call so any backend failure surfaces as one error type.
  const call = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TokenStoreUnavailableError) throw err;
      throw new TokenStoreUnavailableError(`Token store ${backend} operation failed: ${err.message}`, err);
    }
  };

  async function indexUser(indexKey, member, ttl) {
    await adapter.sadd(indexKey, member);
    await adapter.expire(indexKey, ttl);
  }

  const store = {
    backend,

    // Refresh tokens ────────────────────────────────────────────────────────

    setToken(token, ttlSeconds, meta) {
      return call(async () => {
        await adapter.set(KEY.token(token), JSON.stringify(meta), ttlSeconds);
        if (meta && meta.userId && meta.familyId) {
          await indexUser(KEY.userFamilies(meta.userId), meta.familyId, ttlSeconds);
        }
        return meta;
      });
    },

    getToken(token) {
      return call(async () => parse(await adapter.get(KEY.token(token))));
    },

    delToken(token) {
      return call(async () => { await adapter.del(KEY.token(token)); });
    },

    markConsumed(token, familyId, ttlSeconds = DEFAULT_CONSUMED_TTL) {
      return call(async () => { await adapter.set(KEY.consumed(token), familyId, ttlSeconds); });
    },

    getConsumedFamily(token) {
      return call(async () => (await adapter.get(KEY.consumed(token))) || null);
    },

    revokeFamily(familyId, ttlSeconds = DEFAULT_REFRESH_TTL) {
      return call(async () => {
        await adapter.set(KEY.revoked(familyId), '1', ttlSeconds);
        return 1;
      });
    },

    isFamilyRevoked(familyId) {
      return call(async () => (await adapter.exists(KEY.revoked(familyId))) === 1);
    },

    // Sessions ──────────────────────────────────────────────────────────────

    setSession(sessionId, data, ttlSeconds = DEFAULT_REFRESH_TTL) {
      return call(async () => {
        await adapter.set(KEY.session(sessionId), JSON.stringify(data), ttlSeconds);
        if (data && data.userId) {
          await indexUser(KEY.userSessions(data.userId), sessionId, ttlSeconds);
        }
        return data;
      });
    },

    getSession(sessionId) {
      return call(async () => parse(await adapter.get(KEY.session(sessionId))));
    },

    delSession(sessionId) {
      return call(async () => {
        const sess = parse(await adapter.get(KEY.session(sessionId)));
        await adapter.del(KEY.session(sessionId));
        if (sess && sess.userId) {
          await adapter.srem(KEY.userSessions(sess.userId), sessionId);
        }
        return Boolean(sess);
      });
    },

    listUserSessions(userId) {
      return call(async () => {
        const indexKey = KEY.userSessions(userId);
        const ids = await adapter.smembers(indexKey);
        const result = [];
        for (const sessionId of ids) {
          const sess = parse(await adapter.get(KEY.session(sessionId)));
          if (sess) {
            result.push({ sessionId, ...sess });
          } else {
            // Expired session: prune it from the user's index.
            await adapter.srem(indexKey, sessionId);
          }
        }
        return result;
      });
    },

    // Bulk revocation ───────────────────────────────────────────────────────

    revokeAllUserTokens(userId, ttlSeconds = DEFAULT_REFRESH_TTL) {
      return call(async () => {
        const uid = String(userId);
        const familyIndex = KEY.userFamilies(uid);
        const sessionIndex = KEY.userSessions(uid);

        const families = await adapter.smembers(familyIndex);
        for (const familyId of families) {
          await adapter.set(KEY.revoked(familyId), '1', ttlSeconds);
        }
        await adapter.del(familyIndex);

        const sessionIds = await adapter.smembers(sessionIndex);
        for (const sessionId of sessionIds) {
          await adapter.del(KEY.session(sessionId));
        }
        await adapter.del(sessionIndex);

        return { families: families.length, sessions: sessionIds.length };
      });
    },
  };

  return store;
}

// ── Backend selection ─────────────────────────────────────────────────────────

let _memoryStore = null;
let _redisStore = null;
let _lastFallbackWarnAt = 0;
const FALLBACK_WARN_THROTTLE_MS = 60000;

function getMemoryStore() {
  if (!_memoryStore) _memoryStore = createTokenStore(makeMemoryAdapter(), 'memory');
  return _memoryStore;
}

function getRedisStoreFor(client) {
  if (!_redisStore || _redisStore.client !== client) {
    const store = createTokenStore(makeRedisAdapter(client), 'redis');
    _redisStore = Object.assign(store, { client });
  }
  return _redisStore;
}

const STORE_METHODS = [
  'setToken', 'getToken', 'delToken', 'markConsumed', 'getConsumedFamily',
  'revokeFamily', 'isFamilyRevoked', 'setSession', 'getSession', 'delSession',
  'listUserSessions', 'revokeAllUserTokens',
];

function createUnavailableStore() {
  const store = { backend: 'unavailable' };
  for (const name of STORE_METHODS) {
    store[name] = async () => {
      throw new TokenStoreUnavailableError('Redis-backed token store is not ready');
    };
  }
  return store;
}

const _unavailableStore = createUnavailableStore();

/** The shared Redis client, but only once it is connected and ready. */
function readyRedisClient() {
  const client = getRedisClient();
  return client && client.status === 'ready' ? client : null;
}

/**
 * Return the active token/session store. Cheap to call on every request.
 * @returns {object} a store implementing the interface documented above
 */
function getStore() {
  if (!process.env.REDIS_HOST) return getMemoryStore();

  const client = readyRedisClient();
  if (client) return getRedisStoreFor(client);

  if (process.env.NODE_ENV === 'production') return _unavailableStore;

  const nowMs = Date.now();
  if (nowMs - _lastFallbackWarnAt >= FALLBACK_WARN_THROTTLE_MS) {
    _lastFallbackWarnAt = nowMs;
    logger.warn('[SessionStore] Redis not ready — using process-local memory store (non-production only)');
  }
  return getMemoryStore();
}

/**
 * Name of the backend a request would use right now.
 * @returns {'redis'|'memory'|'unavailable'}
 */
function getTokenStoreType() {
  return getStore().backend;
}

/**
 * Startup guard. In production with REDIS_HOST set, waits for Redis to become
 * ready and throws if it does not, so the process never serves logins from a
 * per-process store. Without REDIS_HOST it only warns, because single-node
 * deployments are supported.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000]
 * @param {number} [options.intervalMs=500]
 * @returns {Promise<'redis'|'memory'>}
 */
async function assertTokenStoreReady({ timeoutMs = 30000, intervalMs = 500 } = {}) {
  if (process.env.NODE_ENV !== 'production') return getTokenStoreType() === 'redis' ? 'redis' : 'memory';

  if (!process.env.REDIS_HOST) {
    logger.warn('[SessionStore] REDIS_HOST is not set — refresh tokens and sessions are process-local. Do not run multiple replicas.');
    return 'memory';
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readyRedisClient()) return 'redis';
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new TokenStoreUnavailableError(
    `Redis is required in production for the token store but was not ready within ${timeoutMs}ms`
  );
}

/** Test helper: forget cached stores so the next getStore() starts clean. */
function _resetStore() {
  _memoryStore = null;
  _redisStore = null;
}

/**
 * Revoke every refresh-token family and session belonging to a user. Used by
 * password reset/change, deactivation, deletion and MFA disable so that
 * pre-existing credentials stop working immediately.
 *
 * @param {string|number} userId
 * @returns {Promise<{ families: number, sessions: number }>}
 */
async function revokeAllUserSessions(userId) {
  return getStore().revokeAllUserTokens(String(userId), parseTTL('JWT_REFRESH_TOKEN_TTL', DEFAULT_REFRESH_TTL));
}

module.exports = {
  getStore,
  getTokenStoreType,
  assertTokenStoreReady,
  revokeAllUserSessions,
  parseTTL,
  TokenStoreUnavailableError,
  createTokenStore,
  makeMemoryAdapter,
  _resetStore,
};
