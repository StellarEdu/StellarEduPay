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
      res.set('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json(message);
    }

    next();
  };
}

const generalLimiter       = rl(15 * 60 * 1000, 100);
const strictLimiter        = rl(15 * 60 * 1000, 10);
const verifyLimiter        = rl(60 * 1000, parseInt(process.env.VERIFY_RATE_LIMIT || '10', 10));
const reminderTriggerLimiter = rl(60 * 60 * 1000, 5, { error: 'Too many reminder requests. Please wait.', code: 'RATE_LIMIT_EXCEEDED' });
const bulkImportLimiter    = rl(
  60 * 60 * 1000,
  parseInt(process.env.BULK_IMPORT_RATE_LIMIT, 10) || 5,
  { error: 'Maximum 5 bulk imports per hour.', code: 'RATE_LIMIT_EXCEEDED' },
  { keyGenerator: (req) => req.schoolId || 'unknown-tenant' },
);

module.exports = { generalLimiter, strictLimiter, verifyLimiter, reminderTriggerLimiter, bulkImportLimiter };
