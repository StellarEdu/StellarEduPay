'use strict';

/**
 * Redis reconnection-policy tests (Issue #83).
 *
 * Every Redis consumer (queue, SSE pub/sub, distributed lock, rate limiter,
 * refresh-token store) shares one reconnection policy via
 * getRedisConnectionOptions(). These tests pin that policy: exponential backoff
 * that gives up after a bounded number of attempts, transient-only
 * reconnectOnError, and that per-consumer overrides compose correctly.
 */

const { getRedisConnectionOptions } = require('../src/config/redisClient');

describe('shared Redis connection options', () => {
  test('exposes a consistent base policy', () => {
    const opts = getRedisConnectionOptions();
    expect(typeof opts.retryStrategy).toBe('function');
    expect(typeof opts.reconnectOnError).toBe('function');
    expect(opts.enableOfflineQueue).toBe(false);
    expect(opts.connectTimeout).toBeGreaterThan(0);
  });

  test('retryStrategy backs off and eventually gives up', () => {
    const { retryStrategy } = getRedisConnectionOptions();
    const first = retryStrategy(1);
    const second = retryStrategy(2);
    expect(second).toBeGreaterThanOrEqual(first);
    // After the bounded attempts it returns null (stop reconnecting).
    expect(retryStrategy(1000)).toBeNull();
  });

  test('reconnectOnError reconnects only on transient errors', () => {
    const { reconnectOnError } = getRedisConnectionOptions();
    expect(reconnectOnError(new Error('connect ECONNREFUSED 127.0.0.1:6379'))).toBe(true);
    expect(reconnectOnError(new Error('ETIMEDOUT'))).toBe(true);
    expect(reconnectOnError(new Error('WRONGPASS invalid password'))).toBe(false);
    expect(reconnectOnError(null)).toBe(false);
  });

  test('overrides compose over the base policy (pub/sub needs null max retries)', () => {
    const opts = getRedisConnectionOptions({ maxRetriesPerRequest: null });
    expect(opts.maxRetriesPerRequest).toBeNull();
    // Base policy is still present after override.
    expect(typeof opts.retryStrategy).toBe('function');
    expect(opts.enableOfflineQueue).toBe(false);
  });
});

describe('retry backend replica detection', () => {
  const selector = require('../src/services/retryServiceSelector');
  const orig = { ...process.env };
  afterEach(() => {
    process.env.REPLICA_COUNT = orig.REPLICA_COUNT;
    process.env.WEB_CONCURRENCY = orig.WEB_CONCURRENCY;
  });

  test('defaults to 1 when no replica env var set', () => {
    delete process.env.REPLICA_COUNT;
    delete process.env.WEB_CONCURRENCY;
    delete process.env.INSTANCE_COUNT;
    delete process.env.NUMBER_OF_REPLICAS;
    expect(selector.getReplicaCount()).toBe(1);
  });

  test('reads REPLICA_COUNT', () => {
    process.env.REPLICA_COUNT = '4';
    expect(selector.getReplicaCount()).toBe(4);
  });

  test('falls back to WEB_CONCURRENCY', () => {
    delete process.env.REPLICA_COUNT;
    process.env.WEB_CONCURRENCY = '3';
    expect(selector.getReplicaCount()).toBe(3);
  });
});
