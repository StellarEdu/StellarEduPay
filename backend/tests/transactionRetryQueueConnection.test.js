'use strict';

/**
 * Regression tests for the BullMQ retry queue's shared Redis connection.
 *
 * The retry queue must use the centralized ioredis client and keep the
 * `maxRetriesPerRequest: null` requirement BullMQ needs for blocking consumers.
 *
 * These tests mock ioredis + bullmq so they run without a live Redis, and:
 *   1. assert the dedicated queue connection carries the required blocking
 *      options (the exact regression guard);
 *   2. assert initializeQueue() boots and hands those options to QueueEvents;
 *   3. assert a failed payment that has exhausted its attempts lands in the DLQ.
 */

// Capture options used by the shared client and connections passed to BullMQ.
const capture = {
  redisOptions: [],
  queueEventsConnections: [],
  workerProcessor: null,
  dlqAddCalls: [],
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((options) => {
    capture.redisOptions.push(options);
    return {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
  });
});

jest.mock('bullmq', () => {
  class Queue {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
    }
    add(...args) {
      // The dead-letter queue is the only Queue we add to directly in tests.
      if (this.name === 'transaction-dead-letter-queue') {
        capture.dlqAddCalls.push(args);
      }
      return Promise.resolve({ id: 'job-1' });
    }
    getJob() { return Promise.resolve(null); }
    close() { return Promise.resolve(); }
  }
  class Worker {
    constructor(name, processor, opts) {
      this.name = name;
      this.opts = opts;
      capture.workerProcessor = processor;
    }
    on() { return this; }
    close() { return Promise.resolve(); }
  }
  class QueueEvents {
    constructor(name, opts) {
      capture.queueEventsConnections.push(opts && opts.connection);
    }
    on() { return this; }
    close() { return Promise.resolve(); }
  }
  return { Queue, Worker, QueueEvents };
});

// Idempotency check + Stellar verification used by the worker processor.
jest.mock('../src/models/paymentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null), // never already processed
}));
jest.mock('../src/services/stellarService', () => ({
  verifyTransaction: jest.fn().mockRejectedValue(
    Object.assign(new Error('Horizon unavailable'), { code: 'HORIZON_UNAVAILABLE' })
  ),
  recordPayment: jest.fn().mockResolvedValue(undefined),
}));

describe('transactionRetryQueue Redis connection', () => {
  let queueModule;

  beforeAll(() => {
    // maxAttempts = 1 so the first failure is immediately terminal -> DLQ.
    process.env.MAX_RETRY_ATTEMPTS = '1';
    process.env.REDIS_HOST = 'localhost';
    jest.resetModules();
    queueModule = require('../src/queue/transactionRetryQueue');
  });

  test('exported queue config preserves the centralized Redis policy', () => {
    expect(queueModule.config.redis.maxRetriesPerRequest).toBeNull();
    expect(queueModule.config.redis.enableOfflineQueue).toBe(false);
    expect(typeof queueModule.config.redis.retryStrategy).toBe('function');
    expect(typeof queueModule.config.redis.reconnectOnError).toBe('function');
  });

  test('initializeQueue boots and gives QueueEvents a connection with maxRetriesPerRequest=null', async () => {
    await expect(queueModule.initializeQueue()).resolves.toBeDefined();

    // Only the shared client is constructed, with BullMQ's required option.
    expect(capture.redisOptions.length).toBeGreaterThan(0);
    expect(capture.redisOptions[0].maxRetriesPerRequest).toBeNull();

    // QueueEvents receives the centralized client instead of creating a module-local one.
    expect(capture.queueEventsConnections.length).toBeGreaterThan(0);
    expect(capture.queueEventsConnections[0]).toBe(
      require('../src/config/redisClient').getRedisClient()
    );
  });

  test('a payment that has exhausted its attempts lands in the DLQ', async () => {
    await queueModule.initializeQueue();
    expect(typeof capture.workerProcessor).toBe('function');

    const job = {
      id: 'tx-deadbeef',
      attemptsMade: 0, // with maxAttempts=1, attemptsMade>=0 means max reached
      data: { transactionHash: 'deadbeef', studentId: 'STU-1' },
    };

    // Processor rethrows after moving to DLQ; we only care about the DLQ side effect.
    await expect(capture.workerProcessor(job)).rejects.toBeDefined();

    expect(capture.dlqAddCalls.length).toBeGreaterThan(0);
    const [, payload] = capture.dlqAddCalls[0];
    expect(payload.originalJobId).toBe('tx-deadbeef');
    expect(payload.transactionHash).toBe('deadbeef');
    expect(payload.originalQueue).toBe('transaction-retry-queue');
  });
});
