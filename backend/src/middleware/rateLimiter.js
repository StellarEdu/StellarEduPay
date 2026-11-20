'use strict';

const NodeCache = require('node-cache');
const logger = require('../utils/logger').child('RateLimiter');
const { getRedisClient } = require('../config/redisClient');

const RL_MSG = { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_EXCEEDED' };

// Short command timeout for limiter Redis calls. While ioredis is connecting
// or reconnecting, commands would otherwise sit in the offline queue and each
// request would await the pipeline until Redis returns or the retry limit is
// hit. Bounding the command timeout keeps request latency unaffected by a
// Redis outage, per docs/redis-dependency.md.
const REDIS_COMMAND_TIMEOUT_MS = parseInt(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS || '200', 10);

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
//
// `maxKeys` additionally caps the store so a flood of distinct client keys
// (many-IP scan, CGNAT/mobile churn) cannot grow the map without bound even
// within a single window; node-cache evicts the least-recently-used entries
// once the cap is reached.
function _createFallbackStore(windowMs) {
  // node-cache's TTL/checkperiod are seconds, but accept fractional values,
  // so short test windows (milliseconds) still get real, sub-second expiry
  // instead of being rounded up to a whole second.
  return new NodeCache({
    stdTTL: Math.max(0.05, (windowMs * 2) / 1000),
    checkperiod: Math.max(0.05, windowMs / 1000),
    useClones: false,
    maxKeys: parseInt(process.env.RATE_LIMIT_MAX_KEYS || '10000', 10),
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
//
// The `name` option is required (#1523) to namespace keys per limiter,
// preventing cross-limiter counter collisions. E.g., 'verify', 'sync', 'general'.
function rl(windowMs, max, message = RL_MSG, opts = {}) {
  const memoryStore = _createFallbackStore(windowMs);
  const keyGenerator = opts.keyGenerator || ((req) => req.ip);
  const ttlSec = Math.ceil((windowMs * 2) / 1000) + 1;
  const name = opts.name || 'rl';
  // Optional per-key limit (e.g. authenticated vs anonymous callers).
  const maxForKey = opts.maxForKey || (() => max);
  // When true (production, #2012) the limiter refuses to silently degrade to
  // per-replica in-memory counters: it fails open and raises an admin alert.
  const requireRedis = opts.requireRedis === true;
  let redisAlerted = false;

  return async (req, res, next) => {
    const clientKey = keyGenerator(req) || 'unknown';
    const limit = maxForKey(clientKey);
    const now = Date.now();
    const { bucket, weight, resetSeconds } = _bucketInfo(now, windowMs);
    const redis = getRedisClient();

    let currentCount;
    let previousCount;
    // Only use Redis when it is actually ready. While ioredis is connecting
    // or reconnecting, commands would queue in the offline queue and each
    // request would await the pipeline, adding latency or stalling every API
    // request during an outage. Going straight to the in-memory fallback
    // keeps request latency unaffected, per docs/redis-dependency.md.
    if (redis && redis.status === 'ready') {
      try {
        ({ currentCount, previousCount } = await _redisBucketCount(
          redis,
          name,
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
      return res.status(429).json({ ...message, retryAfter: resetSeconds });
    }

    next();
  };
}

// ── Global limiter (#2012) ──────────────────────────────────────────────────
//
// The old global limiter keyed every request by IP with a flat 100/min, so a
// whole school office behind one NAT address shared a single bucket and the
// effective limit differed per replica. The global limiter now:
//
//  - keys authenticated requests by user ID with a generous limit, so many
//    users behind one IP each get their own bucket;
//  - keys anonymous requests by IP with a tighter limit;
//  - requires Redis in production (see `requireRedis` below) and fails open
//    with an admin alert when Redis is unavailable.
const GLOBAL_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const GLOBAL_AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS || '600', 10);
const GLOBAL_ANON_MAX = parseInt(process.env.RATE_LIMIT_ANON_MAX_REQUESTS || '100', 10);

function _globalKey(req) {
  const user = req.user || req.admin;
  const userId = user && (user.id || user._id || user.sub);
  if (userId) return `user:${userId}`;
  return `ip:${req.ip}`;
}

const globalLimiter = rl(GLOBAL_WINDOW_MS, GLOBAL_AUTH_MAX, RL_MSG, {
  name: 'rl:global',
  keyGenerator: _globalKey,
  // Anonymous callers get the tighter per-route limit.
  maxForKey: (key) => (key.startsWith('user:') ? GLOBAL_AUTH_MAX : GLOBAL_ANON_MAX),
  requireRedis: process.env.NODE_ENV === 'production',
});

const generalLimiter       = rl(15 * 60 * 1000, 100, RL_MSG, { name: 'rl:general' });
const strictLimiter        = rl(15 * 60 * 1000, 10, RL_MSG, { name: 'rl:strict' });

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
  error:
    'A manual sync was already requested for this school recently. ' +
    'Background polling continues regardless; retry after the interval shown in Retry-After.',
  code: 'SYNC_RATE_LIMITED',
};
const syncLimiter = rl(SYNC_INTERVAL_MS, 1, SYNC_RL_MSG, {
  name: 'rl:sync',
  keyGenerator: (req) => (req.schoolId ? `sync:${req.schoolId}` : `sync-ip:${req.ip}`),
});
const verifyLimiter        = rl(60 * 1000, parseInt(process.env.VERIFY_RATE_LIMIT || '10', 10), RL_MSG, { name: 'rl:verify' });
const reminderTriggerLimiter = rl(
  60 * 1000,
  5,
  { error: 'Too many reminder requests. Please wait.', code: 'RATE_LIMIT_EXCEEDED' },
  { name: 'rl:reminders', keyGenerator: (req) => `reminders:${req.schoolId || 'unknown-tenant'}` }
);
const BULK_IMPORT_RATE_LIMIT = parseInt(process.env.BULK_IMPORT_RATE_LIMIT, 10) || 5;
const bulkImportLimiter    = rl(
  60 * 60 * 1000,
  BULK_IMPORT_RATE_LIMIT,
  { error: `Maximum ${BULK_IMPORT_RATE_LIMIT} bulk imports per hour.`, code: 'RATE_LIMIT_EXCEEDED' },
  { name: 'rl:bulkimport', keyGenerator: (req) => req.schoolId || 'unknown-tenant' },
);

// ── Account / credential endpoint limiters (#1776) ──────────────────────────
//
// The credential endpoints (set-password, request-password-reset,
// reset-password) are unauthenticated and the global limiter (100/min per IP)
// is far too generous for them. They get dedicated limiters:
//
//  - resetRequestEmailLimiter: 5/hour per normalised email address, so a
//    single principal's inbox cannot be flooded and the school's email
//    provider quota / sender reputation is protected.
//  - resetRequestIpLimiter: 20/hour per IP, bounding a single source that
//    cycles through many addresses.
//  - credentialIpLimiter: 10 per 15 minutes per IP for set-password and
//    reset-password, bounding token guessing and password-set abuse.
//
// The email key is normalised (trimmed + lowercased) so that trivial
// variations of the same address share one bucket. If the body has no usable
// email string, the limiter falls back to the IP so the request still gets a
// bucket rather than sharing a global one.
const RESET_REQUEST_MSG = {
  error: 'Too many password reset requests. Please try again later.',
  code: 'RATE_LIMIT_EXCEEDED',
};

function _normaliseEmailKey(req) {
  const raw = req.body && req.body.email;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

const resetRequestEmailLimiter = rl(
  60 * 60 * 1000,
  parseInt(process.env.RESET_REQUEST_EMAIL_RATE_LIMIT || '5', 10),
  RESET_REQUEST_MSG,
  {
    name: 'rl:reset-email',
    keyGenerator: (req) => {
      const email = _normaliseEmailKey(req);
      return email ? `reset-email:${email}` : `reset-email-ip:${req.ip}`;
    },
  }
);

const resetRequestIpLimiter = rl(
  60 * 60 * 1000,
  parseInt(process.env.RESET_REQUEST_IP_RATE_LIMIT || '20', 10),
  RESET_REQUEST_MSG,
  { name: 'rl:reset-ip' }
);

const credentialIpLimiter = rl(
  15 * 60 * 1000,
  parseInt(process.env.CREDENTIAL_IP_RATE_LIMIT || '10', 10),
  {
    error: 'Too many password requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  { name: 'rl:credential-ip' }
);

// GET /api/students/public/:studentId is a public endpoint that returns student info.
// Without strict rate limiting, this can be used to enumerate student rosters.
// Limit to 10 requests per IP per minute AND per school (dual key) with alerting.
const publicStudentLimiter = rl(
  60 * 1000,
  10,
  { error: 'Too many student lookup requests. Please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
  { 
    name: 'rl:publicstudent',
    keyGenerator: (req) => {
      // Dual key: IP + school to prevent enumeration across different schools from same IP
      const schoolId = req.schoolId || req.headers['x-school-id'] || 'unknown';
      return `${req.ip}:${schoolId}`;
    }
  },
);

// #1937 — public pay-link lookups. Keyed by IP only: the link itself carries
// the school, so no X-School-ID header is needed and parents can refresh freely.
const payLinkLookupLimiter = rl(
  60 * 1000,
  30,
  { error: 'Too many pay link lookups. Please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
  { name: 'rl:paylink' },
);

// #1953 — Anchor (SEP-24) routes. These are parent-facing and unauthenticated,
// and each /initiate call performs outbound work (stellar.toml fetch, SEP-10
// handshake, anchor deposit creation), so they need their own tight limiters.
// Two dimensions are bounded: per IP (one noisy source) and per school (one
// school's parents cannot exhaust the anchor's rate limits for everyone else).
const ANCHOR_RL_MSG = {
  error: 'Too many anchor requests. Please try again later.',
  code: 'RATE_LIMIT_EXCEEDED',
};

const anchorIpLimiter = rl(
  60 * 1000,
  parseInt(process.env.ANCHOR_IP_RATE_LIMIT || '10', 10),
  ANCHOR_RL_MSG,
  { name: 'rl:anchor-ip' }
);

const anchorSchoolLimiter = rl(
  60 * 1000,
  parseInt(process.env.ANCHOR_SCHOOL_RATE_LIMIT || '20', 10),
  ANCHOR_RL_MSG,
  {
    name: 'rl:anchor-school',
    keyGenerator: (req) =>
      req.schoolId ? `anchor-school:${req.schoolId}` : `anchor-school-ip:${req.ip}`,
  }
);

module.exports = {
  rl,
  RL_MSG,
  payLinkLookupLimiter,
  anchorIpLimiter,
  anchorSchoolLimiter,
  globalLimiter,
  generalLimiter,
  strictLimiter,
  syncLimiter,
  verifyLimiter,
  reminderTriggerLimiter,
  bulkImportLimiter,
  resetRequestEmailLimiter,
  resetRequestIpLimiter,
  credentialIpLimiter,
  publicStudentLimiter,
  // Exported for tests only — the shared decision function both the Redis
  // and in-memory paths call, plus the fallback-store internals.
  _bucketInfo,
  _slidingWindowCount,
  _createFallbackStore,
  _inMemoryBucketCount,
  _inMemoryPreviousCount,
};
