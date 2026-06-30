'use strict';

/**
 * BullMQ worker configuration + backoff tests (Issue #82).
 *
 * Verifies that worker options (concurrency, stalled-job handling, lock
 * duration) are explicitly configured and that the exponential backoff applies
 * jitter within the expected bounds and respects the max-delay cap.
 */

const { config, calculateBackoffDelay } = require('../src/queue/transactionRetryQueue');

describe('worker options are explicitly configured', () => {
  test('concurrency is set', () => {
    expect(config.worker.concurrency).toBeGreaterThan(0);
  });

  test('stalled-job recovery is configured', () => {
    expect(config.worker.lockDuration).toBeGreaterThan(0);
    expect(config.worker.stalledInterval).toBeGreaterThan(0);
    expect(config.worker.maxStalledCount).toBeGreaterThanOrEqual(1);
  });

  test('dead-letter queue is enabled by default', () => {
    expect(config.dlq.enabled).toBe(true);
  });

  test('retry attempts and max delay are bounded', () => {
    expect(config.retry.maxAttempts).toBeGreaterThan(0);
    expect(config.retry.maxDelay).toBeGreaterThan(config.retry.initialDelay);
  });
});

describe('calculateBackoffDelay', () => {
  test('first attempt without jitter equals the initial delay', () => {
    expect(calculateBackoffDelay(1, false)).toBe(config.retry.initialDelay);
  });

  test('grows exponentially without jitter', () => {
    const a1 = calculateBackoffDelay(1, false);
    const a2 = calculateBackoffDelay(2, false);
    const a3 = calculateBackoffDelay(3, false);
    expect(a2).toBe(a1 * config.retry.backoffMultiplier);
    expect(a3).toBe(a1 * config.retry.backoffMultiplier ** 2);
  });

  test('never exceeds the max delay cap', () => {
    for (let attempt = 1; attempt <= 50; attempt++) {
      expect(calculateBackoffDelay(attempt, false)).toBeLessThanOrEqual(config.retry.maxDelay);
      expect(calculateBackoffDelay(attempt, true)).toBeLessThanOrEqual(config.retry.maxDelay);
    }
  });

  test('jitter keeps delays within +/- jitterRatio of the base', () => {
    const base = calculateBackoffDelay(3, false);
    const r = config.jitterRatio;
    for (let i = 0; i < 200; i++) {
      const d = calculateBackoffDelay(3, true);
      expect(d).toBeGreaterThanOrEqual(Math.floor(base * (1 - r)) - 1);
      expect(d).toBeLessThanOrEqual(Math.ceil(base * (1 + r)) + 1);
    }
  });

  test('jitter actually varies the delay', () => {
    const samples = new Set();
    for (let i = 0; i < 20; i++) samples.add(calculateBackoffDelay(3, true));
    expect(samples.size).toBeGreaterThan(1);
  });
});
