'use strict';

/**
 * Regression tests for issue #1795 — fixes that were closed as "completed" but
 * were not effective on main.
 *
 *  - #1593 backup heartbeat routes are mounted at /api/internal
 *  - #1616 receipt / admin-alert / transaction-queue metrics are registered
 *  - #1530 the token store does not stay on the memory fallback forever
 *  - #1531 login lockout honours a lock written to Redis by another replica
 *  - #1557 path payment operations are credited like plain payments
 */

jest.mock('../backend/src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('../backend/src/config/redisClient', () => ({
  getRedisClient: jest.fn(),
  isRedisReady: jest.fn(() => false),
}));

jest.mock('../backend/src/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { getRedisClient, isRedisReady } = require('../backend/src/config/redisClient');
const cache = require('../backend/src/cache');
const metrics = require('../backend/src/metrics');
const { sendAdminAlert } = require('../backend/src/services/alertService');
const authController = require('../backend/src/controllers/authController');

const readSource = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Issue #1795 — #1616 metrics referenced by alerts are registered', () => {
  test.each([
    ['receipt_generation_failures_total'],
    ['send_admin_alert_total'],
    ['transaction_queue_depth'],
  ])('%s is registered in the metrics registry', (name) => {
    expect(metrics.registry.getSingleMetric(name)).toBeDefined();
  });

  test('receiptGenerationFailuresTotal can be incremented by its callers', () => {
    expect(() =>
      metrics.receiptGenerationFailuresTotal.inc({ source: 'verify_controller' })
    ).not.toThrow();
  });

  test('sendAdminAlert increments send_admin_alert_total', async () => {
    const before = (await metrics.sendAdminAlertTotal.get()).values.reduce((a, v) => a + v.value, 0);
    await sendAdminAlert('test alert', {});
    const after = (await metrics.sendAdminAlertTotal.get()).values.reduce((a, v) => a + v.value, 0);
    expect(after).toBe(before + 1);
  });
});

describe('Issue #1795 — #1593 backup heartbeat routes are mounted', () => {
  test('app.js mounts internalRoutes at /api/internal', () => {
    const appSource = readSource('backend/src/app.js');
    expect(appSource).toContain("require('./routes/internalRoutes')");
    expect(appSource).toContain("app.use('/api/internal', internalRoutes)");
  });
});

describe('Issue #1795 — #1530 token store does not pin the memory fallback', () => {
  const makeClient = (status) => ({ status, set: jest.fn().mockResolvedValue('OK') });

  beforeEach(() => {
    authController._resetStore();
    process.env.REDIS_HOST = 'redis.test';
  });

  afterEach(() => {
    delete process.env.REDIS_HOST;
    authController._resetStore();
    jest.clearAllMocks();
  });

  test('uses the Redis store once Redis becomes ready after an outage', async () => {
    const client = makeClient('connecting');
    getRedisClient.mockReturnValue(client);

    // Redis not ready yet — the memory fallback is used
    await authController.getStore().setToken('t1', 60, { familyId: 'f' });
    expect(client.set).not.toHaveBeenCalled();

    // Redis recovers — the next call must switch to the Redis store
    client.status = 'ready';
    await authController.getStore().setToken('t2', 60, { familyId: 'f' });
    expect(client.set).toHaveBeenCalledWith('refresh:token:t2', expect.any(String), 'EX', 60);
  });

  test('does not cache the memory fallback over a later Redis store', () => {
    const client = makeClient('connecting');
    getRedisClient.mockReturnValue(client);
    const fallback = authController.getStore();

    client.status = 'ready';
    expect(authController.getStore()).not.toBe(fallback);
  });
});

describe('Issue #1795 — #1531 login lockout checks Redis across replicas', () => {
  beforeEach(() => {
    cache.get.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
    getRedisClient.mockReset();
    isRedisReady.mockReturnValue(false);
  });

  test('reports locked when another replica wrote the lock to Redis', async () => {
    const redis = { exists: jest.fn().mockResolvedValue(1) };
    getRedisClient.mockReturnValue(redis);
    isRedisReady.mockReturnValue(true);

    await expect(authController.isLockedOut('admin@school.test')).resolves.toBe(true);
    expect(redis.exists).toHaveBeenCalledWith('loginLock:admin@school.test');
  });

  test('reports unlocked when neither the cache nor Redis holds a lock', async () => {
    const redis = { exists: jest.fn().mockResolvedValue(0) };
    getRedisClient.mockReturnValue(redis);
    isRedisReady.mockReturnValue(true);

    await expect(authController.isLockedOut('admin@school.test')).resolves.toBe(false);
  });
});

describe('Issue #1795 — #1557 path payments are credited', () => {
  test('the creditable operation types include both path payment variants', () => {
    const stellarSource = readSource('backend/src/services/stellarService.js');
    expect(stellarSource).toContain('"path_payment_strict_receive"');
    expect(stellarSource).toContain('"path_payment_strict_send"');
    expect(stellarSource).not.toMatch(/op\.type === "payment" && op\.to === walletAddress/);
  });
});
