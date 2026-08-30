'use strict';

/**
 * Tests for #1285 — the in-memory rate-limiter fallback leaked memory
 * (an unbounded, never-pruned Map) and implemented a different windowing
 * algorithm than the Redis path, so the effective limit silently changed
 * whenever Redis dropped out.
 */

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

const mockRedisClient = { getRedisClient: jest.fn(() => null) };
jest.mock('../src/config/redisClient', () => mockRedisClient);

const express = require('express');
const request = require('supertest');
const {
  rl,
  _bucketInfo,
  _slidingWindowCount,
  _createFallbackStore,
  _inMemoryBucketCount,
  _inMemoryPreviousCount,
} = require('../src/middleware/rateLimiter');

function buildApp(limiter) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimiter — shared sliding-window algorithm', () => {
  test('_slidingWindowCount blends the current and previous bucket by elapsed-time weight', () => {
    const windowMs = 60_000;
    // Exactly at the start of a bucket: previous bucket carries full weight.
    const atStart = _bucketInfo(0, windowMs);
    expect(atStart.weight).toBeCloseTo(1, 5);
    expect(_slidingWindowCount(3, 10, atStart.weight)).toBeCloseTo(13, 5);

    // Exactly at the end of a bucket: previous bucket carries no weight.
    const atEnd = _bucketInfo(windowMs - 1, windowMs);
    expect(atEnd.weight).toBeCloseTo(0, 2);
    expect(_slidingWindowCount(3, 10, atEnd.weight)).toBeCloseTo(3, 1);

    // Halfway through: half of the previous bucket still counts.
    const atHalf = _bucketInfo(windowMs / 2, windowMs);
    expect(atHalf.weight).toBeCloseTo(0.5, 2);
  });

  test('prevents the boundary-burst weakness of a plain fixed window', () => {
    // A plain fixed window lets a client send `max` requests at the very end
    // of one bucket and `max` more at the very start of the next — 2x the
    // limit inside a span far shorter than windowMs. The sliding-window
    // estimate must reject that pattern.
    const windowMs = 60_000;
    const max = 10;

    // 10 requests land at the end of bucket 0 (previousCount = 10 once we're
    // in bucket 1). 10 more requests land right at the start of bucket 1.
    const justAfterBoundary = _bucketInfo(windowMs + 1, windowMs);
    const estimateAfterTenMore = _slidingWindowCount(10, 10, justAfterBoundary.weight);

    expect(estimateAfterTenMore).toBeGreaterThan(max);
  });
});

describe('rateLimiter — in-memory fallback store is bounded and self-prunes', () => {
  test('does not retain entries past their bucket TTL, however many distinct keys pass through', async () => {
    const windowMs = 50; // small window so the test runs fast
    const store = _createFallbackStore(windowMs);

    try {
      const distinctClients = 500;
      const now = Date.now();
      const bucket = Math.floor(now / windowMs);

      for (let i = 0; i < distinctClients; i++) {
        _inMemoryBucketCount(store, `client-${i}`, bucket);
      }

      expect(store.keys().length).toBe(distinctClients);

      // Wait past the store's TTL (2 windows) plus a checkperiod tick so
      // node-cache's sweep has run.
      await new Promise((resolve) => setTimeout(resolve, windowMs * 2 + 200));

      expect(store.keys().length).toBeLessThan(distinctClients);
      expect(store.keys().length).toBe(0);
    } finally {
      store.close();
    }
  });

  test('previous-bucket read does not itself write an entry (read-only)', () => {
    const store = _createFallbackStore(1000);
    try {
      const count = _inMemoryPreviousCount(store, 'ghost-client', 5);
      expect(count).toBe(0);
      expect(store.keys().length).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('rateLimiter — Redis and in-memory paths agree on the same request sequence', () => {
  function buildFakeRedis() {
    // Mirrors exactly the bucket scheme the real Redis path uses (INCR
    // current bucket, GET previous bucket, EXPIRE once), backed by a plain
    // object instead of a network round-trip, so we can drive the identical
    // sequence of requests through both "Redis available" and "Redis
    // unavailable" and assert they produce the same allow/deny decisions.
    const data = new Map();
    return {
      status: 'ready',
      pipeline() {
        const ops = [];
        return {
          incr(key) {
            ops.push(['incr', key]);
            return this;
          },
          get(key) {
            ops.push(['get', key]);
            return this;
          },
          async exec() {
            return ops.map(([op, key]) => {
              if (op === 'incr') {
                const next = (data.get(key) || 0) + 1;
                data.set(key, next);
                return [null, next];
              }
              const val = data.get(key);
              return [null, val === undefined ? null : String(val)];
            });
          },
        };
      },
      async expire() {
        return 1;
      },
    };
  }

  test('identical timestamps and request counts produce identical allow/deny sequences', async () => {
    const windowMs = 60_000;
    const max = 3;

    const timestamps = [0, 1000, 2000, 3000, 61_000, 62_000];
    const nowSpy = jest.spyOn(Date, 'now');

    async function driveSequence(limiter, app) {
      const results = [];
      for (const ts of timestamps) {
        nowSpy.mockReturnValue(ts);
        const res = await request(app).get('/ping');
        results.push(res.status);
      }
      return results;
    }

    // Path 1: Redis "available".
    mockRedisClient.getRedisClient.mockReturnValue(buildFakeRedis());
    const redisLimiter = rl(windowMs, max);
    const redisApp = buildApp(redisLimiter);
    const redisResults = await driveSequence(redisLimiter, redisApp);

    // Path 2: Redis unavailable, same limiter construction, same timestamps.
    mockRedisClient.getRedisClient.mockReturnValue(null);
    const memoryLimiter = rl(windowMs, max);
    const memoryApp = buildApp(memoryLimiter);
    const memoryResults = await driveSequence(memoryLimiter, memoryApp);

    nowSpy.mockRestore();

    expect(memoryResults).toEqual(redisResults);
  });
});

describe('rateLimiter — RateLimit-Reset header', () => {
  test('reports seconds remaining in the current window, not the full window length', async () => {
    mockRedisClient.getRedisClient.mockReturnValue(null);
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const limiter = rl(windowMs, 100);
    const app = buildApp(limiter);

    const nowSpy = jest.spyOn(Date, 'now');
    // Land 1 second before a bucket boundary.
    const bucketStart = 10 * windowMs;
    nowSpy.mockReturnValue(bucketStart + windowMs - 1000);

    const res = await request(app).get('/ping');

    nowSpy.mockRestore();

    const resetSeconds = Number(res.headers['ratelimit-reset']);
    expect(resetSeconds).toBeLessThanOrEqual(1);
    expect(resetSeconds).not.toBe(Math.ceil(windowMs / 1000));
  });
});

describe('rateLimiter — Redis EXPIRE is not reissued on every request', () => {
  test('EXPIRE is only called on the bucket\'s first write', async () => {
    const expireSpy = jest.fn().mockResolvedValue(1);
    const data = new Map();
    const fakeRedis = {
      status: 'ready',
      pipeline() {
        const ops = [];
        return {
          incr(key) {
            ops.push(['incr', key]);
            return this;
          },
          get(key) {
            ops.push(['get', key]);
            return this;
          },
          async exec() {
            return ops.map(([op, key]) => {
              if (op === 'incr') {
                const next = (data.get(key) || 0) + 1;
                data.set(key, next);
                return [null, next];
              }
              const val = data.get(key);
              return [null, val === undefined ? null : String(val)];
            });
          },
        };
      },
      expire: expireSpy,
    };
    mockRedisClient.getRedisClient.mockReturnValue(fakeRedis);

    const limiter = rl(60_000, 100);
    const app = buildApp(limiter);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    await request(app).get('/ping');
    await request(app).get('/ping');
    await request(app).get('/ping');
    nowSpy.mockRestore();

    expect(expireSpy).toHaveBeenCalledTimes(1);
  });
});
