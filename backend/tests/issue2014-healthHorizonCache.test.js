'use strict';

/**
 * #2014 — anonymous health probes must not generate a live Horizon request per
 * call. The public endpoints read a short-lived shared cache; a background
 * refresher (and the admin-only detailed endpoint) owns the real probes, and
 * every real probe is charged to the shared Horizon poll budget.
 */

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn(async () => ({ healthy: true, latency: 2 })),
}));

jest.mock('../src/config/stellarConfig', () => {
  const call = jest.fn(async () => ({ records: [] }));
  return {
    horizonClient: {
      call,
      activeUrl: 'https://horizon.test',
      getCircuitBreakerStatus: jest.fn(() => []),
    },
    __horizonCall: call,
    CB_FAILURE_THRESHOLD: 5,
    CB_RESET_TIMEOUT_MS: 60000,
    CB_HALF_OPEN_SUCCESS_THRESHOLD: 2,
  };
});

jest.mock('../src/config', () => ({
  STELLAR_NETWORK: 'testnet',
  HORIZON_URL: 'https://horizon.test',
  MAX_QUEUE_DEPTH: 100,
}));

jest.mock('../src/services/reminderService', () => ({ getReminderStatus: () => ({ status: 'ok' }) }));
jest.mock('../src/services/currencyConversionService', () => ({ getCachedRates: () => ({}) }));
jest.mock('../src/services/auditService', () => ({ getAuditHealth: () => ({ status: 'ok' }) }));
jest.mock('../src/config/redisClient', () => ({
  getRedisStatus: () => ({ configured: false, status: 'not_configured' }),
}));
jest.mock('../src/services/workerHeartbeat', () => ({
  checkLiveness: () => ({ allHealthy: true, workers: {} }),
  WORKER_NAMES: { TX_QUEUE_WORKER: 'txQueueWorker' },
}));
jest.mock('../src/queue/transactionQueue', () => ({ getRecoveryStatus: () => ({ status: 'ok' }) }));
jest.mock('../src/services/shutdownManager', () => ({ isReady: () => true }));
jest.mock('../src/services/studentPiiEncryption', () => ({ isEncryptionEnabled: () => true }));
jest.mock('../src/services/webhookSecretEncryption', () => ({ isEncryptionEnabled: () => true }));
jest.mock('../src/utils/buildInfo', () => ({ getBuildInfo: () => ({ version: '1.0.0', commit: 'abc' }) }));
jest.mock('../src/metrics', () => ({ horizonUp: { set: jest.fn() } }));
jest.mock('../src/services/retryServiceSelector', () => ({
  getSelectedBackend: () => 'mongodb',
  isRunning: () => true,
}));
jest.mock('../src/config/retryQueueSetup', () => ({ getRetryQueueHealth: () => ({ status: 'ok' }) }));
jest.mock('../src/services/transactionPollingService', () => ({ getHorizonUnreachableSince: () => null }));

jest.mock('../src/utils/logger', () => {
  const make = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
  const root = make();
  root.getLevel = () => 'info';
  root.child = make;
  return root;
});

function loadController() {
  jest.resetModules();
  const stellarConfig = require('../src/config/stellarConfig');
  const { sharedPollBudget } = require('../src/services/horizonPollBudget');
  const controller = require('../src/controllers/healthController');
  return {
    controller,
    horizonCall: stellarConfig.__horizonCall,
    sharedPollBudget,
  };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('issue #2014 — cached Horizon status for anonymous health probes', () => {
  test('1000 requests to /health cause at most one Horizon call', async () => {
    const { controller, horizonCall } = loadController();

    const responses = await Promise.all(
      Array.from({ length: 1000 }, () => {
        const res = mockRes();
        return controller.healthCheck({}, res).then(() => res);
      })
    );

    expect(horizonCall).toHaveBeenCalledTimes(1);
    expect(responses[0].statusCode).toBe(200);
    expect(responses[0].body).toEqual({ status: 'healthy' });
    expect(responses[999].body).toEqual({ status: 'healthy' });
  });

  test('concurrent cold-cache reads share one in-flight probe', async () => {
    const { controller, horizonCall } = loadController();
    let release;
    horizonCall.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const first = controller.checkStellar();
    const second = controller.checkStellar();
    expect(horizonCall).toHaveBeenCalledTimes(1);

    release({ records: [] });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(horizonCall).toHaveBeenCalledTimes(1);
  });

  test('background refresher keeps the cache warm and charges the shared budget', async () => {
    jest.useFakeTimers();
    try {
      const { controller, horizonCall, sharedPollBudget } = loadController();
      controller.startHorizonHealthCache();
      await controller.checkStellar();

      expect(horizonCall).toHaveBeenCalledTimes(1);
      expect(sharedPollBudget.getStats().consumedThisCycle).toBe(1);

      // Hammering the public endpoint between ticks cannot add Horizon calls.
      await Promise.all(Array.from({ length: 500 }, () => controller.checkStellar()));
      expect(horizonCall).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(controller.STELLAR_CACHE_TTL_MS);
      await controller.checkStellar();
      expect(horizonCall).toHaveBeenCalledTimes(2);
      expect(sharedPollBudget.getStats().consumedThisCycle).toBe(2);

      controller.stopHorizonHealthCache();
      jest.advanceTimersByTime(controller.STELLAR_CACHE_TTL_MS * 3);
      expect(horizonCall).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('admin details performs a live probe; public /health keeps using the cache', async () => {
    const { controller, horizonCall } = loadController();

    await controller.healthCheck({}, mockRes());
    await controller.healthCheck({}, mockRes());
    expect(horizonCall).toHaveBeenCalledTimes(1);

    const res = mockRes();
    await controller.healthDetails({}, res);
    expect(horizonCall).toHaveBeenCalledTimes(2);
    expect(res.body.checks.stellar.status).toBe('ok');
  });

  test('an exhausted Horizon budget never reaches Horizon and serves the last result', async () => {
    const { controller, horizonCall, sharedPollBudget } = loadController();
    sharedPollBudget.remaining = 0;

    const res = mockRes();
    await controller.healthCheck({}, res);

    expect(horizonCall).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'degraded' });
  });
});
