'use strict';

/**
 * Distributed lock backed by Redis with fencing tokens (`SET key value NX PX ttl`).
 *
 * Used to ensure that only one backend replica (or one overlapping slow poll)
 * processes a given resource — e.g. a school's Stellar sync — at a time.
 *
 * Safety Guarantees:
 *   1. Mutual exclusion: Only one holder can acquire the lock at a time.
 *   2. Fencing tokens: Each acquisition gets a unique, monotonic token. Protected
 *      resources MUST check this token before writes; if a stale holder attempts a
 *      write after another worker acquired the lock, the fencing token will be lower
 *      and the write MUST be rejected.
 *   3. Lease renewal: The watchdog automatically renews the TTL while a job runs,
 *      preventing expiration during long operations. Callers MUST stop renewal before
 *      accessing protected resources.
 *
 * Safety Limits:
 *   - Fencing tokens are only effective if the protected resource checks them.
 *   - The watchdog uses setTimeout; extremely long GC pauses (> TTL/4) may still
 *     cause issues. Keep critical sections short relative to TTL.
 *   - Clock drift between Redis server and client nodes can affect TTL accuracy.
 *
 * Semantics:
 *   acquire(key, ttlMs) -> { token, fencingToken } | null
 *     Atomically takes the lock via SET NX PX. Increments the fencing token counter.
 *     Returns { token, fencingToken } on success, or null when already held.
 *   release(key, token) -> boolean
 *     Releases the lock only if `token` still matches.
 *   renew(key, token, ttlMs) -> boolean
 *     Extends the lock TTL. Used internally by watchdog.
 *   withLock(key, ttlMs, fn, opts) -> Promise<result | onContended>
 *     Runs `fn` while holding the lock, with automatic TTL renewal.
 *     Returns { result, fencingToken } or onContended.
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

// In-process fallback store: key -> { token, fencingToken, expiresAt }
const localLocks = new Map();

// Atomic check-and-delete: only delete when the stored token is ours.
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

// Lua script for atomic fence acquisition: GET current fence value, increment, SET with lock
// Returns the new fencing token on success, or null if lock not acquired
const ACQUIRE_WITH_FENCE_SCRIPT = `
  local lock_key = KEYS[1]
  local fence_key = KEYS[2]
  local lock_value = ARGV[1]
  local ttl = tonumber(ARGV[2])
  
  -- Check if lock is available
  local existing_lock = redis.call("get", lock_key)
  if existing_lock and existing_lock ~= "" then
    return nil
  end
  
  -- Atomically increment fence and set lock
  local fence = redis.call("incr", fence_key)
  redis.call("set", lock_key, lock_value, "PX", ttl)
  
  return fence
`;

// Lua script for renewing the lock TTL
const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

// Fencing token counter key prefix
const FENCE_PREFIX = '__fence__:';

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Get fencing token counter key for a lock key.
 */
function getFenceKey(key) {
  return FENCE_PREFIX + key;
}

/**
 * Attempt to acquire the lock with a fencing token.
 * @param {string} key   Lock key (e.g. `sync:lock:<schoolId>`).
 * @param {number} ttlMs Lock lifetime in milliseconds.
 * @returns {Promise<{token: string, fencingToken: number}|null>} Token info on success, null if already held.
 */
async function acquire(key, ttlMs) {
  const token = newToken();

  if (client) {
    try {
      const fenceKey = getFenceKey(key);
      // Atomically check lock availability, increment fence, and set lock
      const fencingToken = await client.eval(
        ACQUIRE_WITH_FENCE_SCRIPT,
        2,
        key,
        fenceKey,
        token,
        ttlMs
      );
      if (fencingToken === null) return null;
      return { token, fencingToken };
    } catch (err) {
      logger.error('Lock acquire failed', { error: err.message, key });
      return null;
    }
  }

  // In-process fallback.
  const now = Date.now();
  const existing = localLocks.get(key);
  if (existing && existing.expiresAt > now) return null;

  // Use a simple counter for fencing tokens in fallback
  let fenceCounter = 1;
  const existingFence = localLocks.get(getFenceKey(key));
  if (existingFence) {
    fenceCounter = existingFence.fencingToken + 1;
  }
  localLocks.set(getFenceKey(key), { fencingToken: fenceCounter });
  localLocks.set(key, { token, fencingToken: fenceCounter, expiresAt: now + ttlMs });
  return { token, fencingToken: fenceCounter };
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
 * Renew the lock TTL. Used by watchdog to prevent expiration during long jobs.
 * @param {string} key
 * @param {string} token Token returned by acquire().
 * @param {number} ttlMs New TTL in milliseconds.
 * @returns {Promise<boolean>} true if renewal succeeded.
 */
async function renew(key, token, ttlMs) {
  if (!token) return false;

  if (client) {
    try {
      const res = await client.eval(RENEW_SCRIPT, 1, key, token, ttlMs);
      return res === 1;
    } catch (err) {
      logger.error('Lock renew failed', { error: err.message, key });
      return false;
    }
  }

  const existing = localLocks.get(key);
  if (existing && existing.token === token && existing.expiresAt > Date.now()) {
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }
  return false;
}

/**
 * Start a watchdog to periodically renew the lock.
 * Exported for use by callers who need fine-grained control.
 * @param {string} key
 * @param {string} token
 * @param {number} ttlMs
 * @param {number} intervalMs How often to renew (default: ttlMs / 4).
 * @returns {() => void} Stop function to cancel the watchdog.
 */
function startWatchdog(key, token, ttlMs, intervalMs) {
  const actualInterval = intervalMs || Math.floor(ttlMs / 4);
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    const success = await renew(key, token, ttlMs);
    if (!success) {
      logger.warn('Lock renewal failed, watchdog stopping', { key });
      stopped = true;
    }
  }, actualInterval);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/**
 * Run `fn` while holding the lock for `key`. If the lock cannot be acquired the
 * function is not run and `onContended` (default: undefined) is returned.
 *
 * @param {string} key
 * @param {number} ttlMs Lock lifetime.
 * @param {function} fn Async function to run while holding lock.
 * @param {object} [opts] Options object.
 * @param {*} [opts.onContended] Value to return if lock was contended.
 * @param {number} [opts.watchdogInterval] Renewal interval (default: ttlMs/4).
 * @returns {Promise<{result: *, fencingToken: number, stopWatchdog: function}|*>}
 */
async function withLock(key, ttlMs, fn, opts = {}) {
  const acquired = await acquire(key, ttlMs);
  if (!acquired) return opts.onContended;

  const { token, fencingToken } = acquired;
  const stopWatchdog = startWatchdog(key, token, ttlMs, opts.watchdogInterval);

  try {
    const result = await fn(token, fencingToken);
    return { result, fencingToken, stopWatchdog };
  } finally {
    stopWatchdog();
    await release(key, token);
  }
}

/**
 * Get current fencing token for a lock key (for protected resources to check).
 * @param {string} key
 * @returns {Promise<number|null>} Current fencing token if lock is held, null otherwise.
 */
async function getCurrentFence(key) {
  if (client) {
    try {
      const fenceKey = getFenceKey(key);
      const res = await client.get(fenceKey);
      return res ? parseInt(res, 10) : null;
    } catch (err) {
      return null;
    }
  }
  const existing = localLocks.get(key);
  return existing ? existing.fencingToken : null;
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
  renew,
  withLock,
  getCurrentFence,
  startWatchdog,
  close,
  _isRedisEnabled: () => Boolean(client),
  _getFenceKey: getFenceKey,
};
