'use strict';

const mockRedisConnections = [];
let mockDuplicateCalls = 0;

jest.mock('ioredis', () => {
  const EventEmitter = require('events');
  return class MockRedis extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      mockRedisConnections.push(this);
    }

    duplicate(options) {
      mockDuplicateCalls++;
      return new MockRedis({ ...this.options, ...options });
    }

    connect() {
      return Promise.resolve();
    }

    subscribe() {
      return Promise.resolve();
    }

    unsubscribe() {
      return Promise.resolve();
    }

    publish() {
      return Promise.resolve(1);
    }

    quit() {
      return Promise.resolve('OK');
    }
  };
});

describe('shared Redis client ownership', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.REDIS_HOST = 'redis.example';
    process.env.REDIS_PORT = '6380';
    mockRedisConnections.length = 0;
    mockDuplicateCalls = 0;
    jest.resetModules();
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test('reuses one command client and one policy-configured subscriber', async () => {
    const redisClient = require('../src/config/redisClient');

    const commandClient = redisClient.getRedisClient();
    expect(redisClient.getRedisClient()).toBe(commandClient);
    expect(commandClient.options).toMatchObject({
      host: 'redis.example',
      port: 6380,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });

    const subscriber = redisClient.getRedisSubscriber();
    expect(redisClient.getRedisSubscriber()).toBe(subscriber);
    expect(mockRedisConnections).toHaveLength(2);
    expect(mockDuplicateCalls).toBe(1);
    expect(subscriber.options).toMatchObject({
      host: 'redis.example',
      port: 6380,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });

    await redisClient.closeRedisClients();
  });

  test('Redis-backed services reuse the same command and subscriber clients', async () => {
    const redisClient = require('../src/config/redisClient');
    require('../src/services/distributedLock');
    require('../src/services/idempotencyStore');
    require('../src/services/sseService');
    require('../src/services/schoolCacheInvalidator');
    require('../src/services/reportCacheInvalidator');

    expect(mockRedisConnections).toHaveLength(2);
    expect(mockDuplicateCalls).toBe(1);

    await redisClient.closeRedisClients();
  });
});
