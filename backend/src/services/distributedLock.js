'use strict';

/**
 * Distributed lock backed by Redis (`SET key token NX PX ttl`).
 *
 * Used to ensure that only one backend replica (or one overlapping slow poll)
 * processes a given resource — e.g. a school's Stellar sync — at a time.
 *
 * Semantics:
 *   acquire(key, ttlMs) -> token | null
 *     Atomically takes the lock via SET NX PX. Returns an opaque token on
 *     success, or null when another holder already owns the lock.
 *   release(key, token) -> boolean
 *     Releases the lock only if `token` still matches the stored value, so a
 *     worker can never release a lock that has since expired and been retaken
 *     by someone else (check-and-delete is done atomically with a Lua script).
 *
 * The TTL is the safety net: if a holder crashes without releasing, the lock
 * auto-expires after ttlMs and another worker can take over. Correctness of the
 * underlying writes must therefore NOT depend solely on the lock — the unique
 * index on Payment { schoolId, txHash } remains the authoritative dedup guard.
 *
 * When REDIS_HOST is not configured the lock degrades to an in-process Map.
 * That is correct for a single replica (the only contention is overlapping
 * polls inside one process) and keeps the service runnable without Redis.
 */

const crypto = require('crypto');
const logger = require('../utils/logger').child('DistributedLock');
const { getRedisConnectionOptions } = require('../config/redisClient');

const redisEnabled = Boolean(process.env.REDIS_HOST);

// Share the central reconnection policy (Issue #83) so the lock client backs off
// and treats transient errors identically to every other Redis consumer.
// maxRetriesPerRequest: null lets a command wait through a reconnect rather than
// erroring immediately, so a brief blip doesn't spuriously deny every lock.
const redisConfig = getRedisConnectionOptions({ maxRetriesPerRequest: null });

let client = null;

if (redisEnabled) {
  const Redis = require('ioredis');
  client = new Redis(redisConfig);
  client.on('error', (err) => logger.error('Redis lock client error', { error: err.message }));
  client.connect().catch((err) =>
    logger.error('Redis lock client connect failed', { error: err.message })
  );
}

// In-process fallback store: key -> { token, expiresAt }
const localLocks = new Map();

// Atomic check-and-delete: only delete when the stored token is ours.
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Attempt to acquire the lock.
 * @param {string} key   Lock key (e.g. `sync:lock:<schoolId>`).
 * @param {number} ttlMs Lock lifetime in milliseconds.
 * @returns {Promise<string|null>} A release token, or null if already held.
 */
async function acquire(key, ttlMs) {
  const token = newToken();

  if (client) {
    try {
      const res = await client.set(key, token, 'PX', ttlMs, 'NX');
      return res === 'OK' ? token : null;
    } catch (err) {
      // On a Redis failure we refuse the lock rather than risk two workers
      // both proceeding. The unique index still prevents duplicate writes; the
      // caller simply skips this cycle and retries next interval.
      logger.error('Lock acquire failed', { error: err.message, key });
      return null;
    }
  }

  // In-process fallback.
  const now = Date.now();
  const existing = localLocks.get(key);
  if (existing && existing.expiresAt > now) return null;
  localLocks.set(key, { token, expiresAt: now + ttlMs });
  return token;
}

/**
 * Release a previously acquired lock if we still own it.
 * @param {string} key
 * @param {string} token Token returned by acquire().
 * @returns {Promise<boolean>} true if this call released the lock.
 */
async function release(key, token) {
  if (!token) return false;

  if (client) {
    try {
      const res = await client.eval(RELEASE_SCRIPT, 1, key, token);
      return res === 1;
    } catch (err) {
      logger.error('Lock release failed', { error: err.message, key });
      return false;
    }
  }

  const existing = localLocks.get(key);
  if (existing && existing.token === token) {
    localLocks.delete(key);
    return true;
  }
  return false;
}

/**
 * Run `fn` while holding the lock for `key`. If the lock cannot be acquired the
 * function is not run and `onContended` (default: undefined) is returned.
 */
async function withLock(key, ttlMs, fn, onContended) {
  const token = await acquire(key, ttlMs);
  if (!token) return onContended;
  try {
    return await fn();
  } finally {
    await release(key, token);
  }
}

async function close() {
  try {
    if (client) await client.quit();
  } catch (err) {
    logger.error('Error closing Redis lock client', { error: err.message });
  }
}

module.exports = {
  acquire,
  release,
  withLock,
  close,
  // Exposed for testing
  _isRedisEnabled: () => Boolean(client),
};
