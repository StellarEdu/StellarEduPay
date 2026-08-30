'use strict';

const logger = require('../utils/logger').child('RateLimiter');
const { getRedisClient } = require('../config/redisClient');

const RL_MSG = { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_EXCEEDED' };

function _inMemoryIncrement(store, key, now, windowStart) {
  let entry = store.get(key);
  if (!entry || entry.windowStart < windowStart) {
    entry = { windowStart: now, count: 0 };
  }
  entry.count++;
  store.set(key, entry);
  return entry.count;
}

// Redis-backed limiter shared across replicas, matching the counter scheme
// already used by concurrentRequestHandler.js. Falls back to an in-process
// counter (per replica) if Redis is unavailable, per docs/redis-dependency.md.
function rl(windowMs, max, message = RL_MSG, opts = {}) {
  const memoryStore = new Map();
  const keyGenerator = opts.keyGenerator || ((req) => req.ip);

  return async (req, res, next) => {
    const clientKey = keyGenerator(req) || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const bucket = Math.floor(now / windowMs) * windowMs;
    const redisKey = `rl:${clientKey}:${bucket}`;
    const redis = getRedisClient();

    let count;
    if (redis && redis.status !== 'end') {
      try {
        const ttlSec = Math.ceil(windowMs / 1000) + 1;
        const [[, cnt]] = await redis.pipeline().incr(redisKey).expire(redisKey, ttlSec).exec();
        count = cnt;
      } catch (err) {
        logger.warn('Redis op failed, using in-memory fallback', { error: err.message });
        count = _inMemoryIncrement(memoryStore, clientKey, now, windowStart);
      }
    } else {
      count = _inMemoryIncrement(memoryStore, clientKey, now, windowStart);
    }

    res.set({
      'RateLimit-Limit': max,
      'RateLimit-Remaining': Math.max(0, max - count),
      'RateLimit-Reset': Math.ceil(windowMs / 1000),
    });

    if (count > max) {
      // Buckets are fixed windows, so the wait is the remainder of the current
      // one — reporting the full window would over-state it by up to windowMs.
      const retryAfterSec = Math.max(1, Math.ceil((bucket + windowMs - now) / 1000));
      res.set('Retry-After', retryAfterSec);
      return res.status(429).json(message);
    }

    next();
  };
}

const generalLimiter       = rl(15 * 60 * 1000, 100);
const strictLimiter        = rl(15 * 60 * 1000, 10);

// POST /api/payments/sync triggers a full Horizon sync for one school's wallet.
// The global limiter is per IP, so one school scripting the endpoint could
// exhaust the shared Horizon budget, trip the circuit breaker and stall
// background polling for everyone. This bounds it to one manual sync per school
// per poll interval - beyond that the background poller already covers it.
//
// Keyed on schoolId, falling back to the IP so a request that somehow arrives
// without school context still gets its own bucket rather than sharing one.
const SYNC_INTERVAL_MS = parseInt(
  process.env.SYNC_INTERVAL_MS || process.env.POLL_INTERVAL_MS || '60000',
  10,
);
const SYNC_RL_MSG = {
  success: false,
  error: {
    code: 'SYNC_RATE_LIMITED',
    message:
      'A manual sync was already requested for this school recently. ' +
      'Background polling continues regardless; retry after the interval shown in Retry-After.',
  },
};
const syncLimiter = rl(SYNC_INTERVAL_MS, 1, SYNC_RL_MSG, {
  keyGenerator: (req) => (req.schoolId ? `sync:${req.schoolId}` : `sync-ip:${req.ip}`),
});
const verifyLimiter        = rl(60 * 1000, parseInt(process.env.VERIFY_RATE_LIMIT || '10', 10));
const reminderTriggerLimiter = rl(
  60 * 1000,
  5,
  { error: 'Too many reminder requests. Please wait.', code: 'RATE_LIMIT_EXCEEDED' },
  { keyGenerator: (req) => `reminders:${req.schoolId || 'unknown-tenant'}` }
);
const bulkImportLimiter    = rl(
  60 * 60 * 1000,
  parseInt(process.env.BULK_IMPORT_RATE_LIMIT, 10) || 5,
  { error: 'Maximum 5 bulk imports per hour.', code: 'RATE_LIMIT_EXCEEDED' },
  { keyGenerator: (req) => req.schoolId || 'unknown-tenant' },
);

module.exports = { rl, generalLimiter, strictLimiter, syncLimiter, SYNC_INTERVAL_MS, verifyLimiter, reminderTriggerLimiter, bulkImportLimiter };
