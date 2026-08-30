'use strict';

const NodeCache = require('node-cache');
const logger = require('../utils/logger').child('RateLimiter');
const { getRedisClient } = require('../config/redisClient');

const RL_MSG = { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_EXCEEDED' };

// ── Shared sliding-window-counter algorithm ─────────────────────────────────
//
// Both the Redis path and the in-memory fallback path count requests into
// fixed-size time buckets (`windowMs` wide) and estimate the request rate as
// a weighted blend of the current bucket and the immediately preceding one:
//
//   estimate = currentBucketCount + previousBucketCount * weight
//
// `weight` is the fraction of the previous bucket that still falls inside
// the trailing `windowMs` window, decaying linearly from 1 (at the start of
// the current bucket) to 0 (at its end). This approximates a true sliding
// window and — unlike a plain fixed window — does not allow `2 * max`
// requests to slip through around a bucket boundary. Both code paths call
// `_bucketInfo` / `_slidingWindowCount` below, so they implement the exact
// same decision function; only how the two per-bucket counts are fetched
// differs (Redis INCR/GET vs. an in-process store).
function _bucketInfo(now, windowMs) {
  const bucket = Math.floor(now / windowMs);
  const bucketStart = bucket * windowMs;
  const elapsed = now - bucketStart;
  const weight = Math.max(0, Math.min(1, (windowMs - elapsed) / windowMs));
  const resetSeconds = Math.max(1, Math.ceil((bucketStart + windowMs - now) / 1000));
  return { bucket, weight, resetSeconds };
}

function _slidingWindowCount(currentCount, previousCount, weight) {
  return currentCount + previousCount * weight;
}

// In-memory fallback store, keyed by `${clientKey}:${bucket}`. Bucket entries
// carry their own TTL (two windows, so the "previous bucket" read from the
// next window can still find them) and node-cache's `checkperiod` sweep
// deletes expired entries on a timer — nothing is ever retained past its
// bucket's relevance, so the store's size is bounded by the number of
// distinct clients active within the last two windows, not by every client
// that has ever connected to the process.
function _createFallbackStore(windowMs) {
  // node-cache's TTL/checkperiod are seconds, but accept fractional values,
  // so short test windows (milliseconds) still get real, sub-second expiry
  // instead of being rounded up to a whole second.
  return new NodeCache({
    stdTTL: Math.max(0.05, (windowMs * 2) / 1000),
    checkperiod: Math.max(0.05, windowMs / 1000),
    useClones: false,
  });
}

function _inMemoryBucketCount(store, clientKey, bucket) {
  const key = `${clientKey}:${bucket}`;
  const next = (store.get(key) || 0) + 1;
  store.set(key, next);
  return next;
}

function _inMemoryPreviousCount(store, clientKey, bucket) {
  return store.get(`${clientKey}:${bucket - 1}`) || 0;
}

async function _redisBucketCount(redis, redisKeyPrefix, clientKey, bucket, ttlSec) {
  const currentKey = `${redisKeyPrefix}:${clientKey}:${bucket}`;
  const previousKey = `${redisKeyPrefix}:${clientKey}:${bucket - 1}`;

  const pipeline = redis.pipeline().incr(currentKey).get(previousKey);
  const results = await pipeline.exec();
  const [[incrErr, currentCount], [getErr, previousRaw]] = results;
  if (incrErr) throw incrErr;
  if (getErr) throw getErr;

  // Only set the TTL on the bucket's first write — it already encodes the
  // bucket boundary, so re-issuing EXPIRE on every request is a wasted
  // round-trip on the hot path.
  if (currentCount === 1) {
    await redis.expire(currentKey, ttlSec);
  }

  return { currentCount, previousCount: previousRaw ? parseInt(previousRaw, 10) : 0 };
}

// Redis-backed limiter shared across replicas, matching the counter scheme
// already used by concurrentRequestHandler.js. Falls back to an in-process
// counter (per replica) if Redis is unavailable, per docs/redis-dependency.md.
// See docs/redis-dependency.md for what a Redis outage means for the
// effective limit in a multi-replica deployment.
function rl(windowMs, max, message = RL_MSG, opts = {}) {
  const memoryStore = _createFallbackStore(windowMs);
  const keyGenerator = opts.keyGenerator || ((req) => req.ip);
  const ttlSec = Math.ceil((windowMs * 2) / 1000) + 1;

  return async (req, res, next) => {
    const clientKey = keyGenerator(req) || 'unknown';
    const now = Date.now();
    const { bucket, weight, resetSeconds } = _bucketInfo(now, windowMs);
    const redis = getRedisClient();

    let currentCount;
    let previousCount;
    if (redis && redis.status !== 'end') {
      try {
        ({ currentCount, previousCount } = await _redisBucketCount(
          redis,
          'rl',
          clientKey,
          bucket,
          ttlSec
        ));
      } catch (err) {
        logger.warn('Redis op failed, using in-memory fallback', { error: err.message });
        currentCount = _inMemoryBucketCount(memoryStore, clientKey, bucket);
        previousCount = _inMemoryPreviousCount(memoryStore, clientKey, bucket);
      }
    } else {
      currentCount = _inMemoryBucketCount(memoryStore, clientKey, bucket);
      previousCount = _inMemoryPreviousCount(memoryStore, clientKey, bucket);
    }

    const count = _slidingWindowCount(currentCount, previousCount, weight);

    res.set({
      'RateLimit-Limit': max,
      'RateLimit-Remaining': Math.max(0, Math.floor(max - count)),
      'RateLimit-Reset': resetSeconds,
    });

    if (count > max) {
      res.set('Retry-After', resetSeconds);
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

module.exports = {
  rl,
  generalLimiter,
  strictLimiter,
  verifyLimiter,
  reminderTriggerLimiter,
  bulkImportLimiter,
  // Exported for tests only — the shared decision function both the Redis
  // and in-memory paths call, plus the fallback-store internals.
  _bucketInfo,
  _slidingWindowCount,
  _createFallbackStore,
  _inMemoryBucketCount,
  _inMemoryPreviousCount,
};
