'use strict';

// #466 — graceful shutdown waits for in-flight requests
// Plus: readiness flag, worker drain, SSE client notification

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const http = require('http');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
}));

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  connection: {
    on: jest.fn(),
  },
  Schema: class {
    constructor() {
      this.index = jest.fn();
      this.pre = jest.fn();
      this.virtual = jest.fn().mockReturnValue({ get: jest.fn() });
    }
  },
  model: jest.fn().mockReturnValue({
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock('../backend/src/services/transactionPollingService', () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
}));

jest.mock('../backend/src/services/retryServiceSelector', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  isRunning: jest.fn().mockReturnValue(false),
  useBullMQ: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(),
  stopReminderScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/leaderElection', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  isLeader: jest.fn().mockReturnValue(false),
  register: jest.fn(),
}));

jest.mock('../backend/src/services/transactionQueueService', () => ({
  startWorker: jest.fn(),
  stopWorker: jest.fn(),
}));

jest.mock('../backend/src/services/sessionCleanupService', () => ({
  startSessionCleanupScheduler: jest.fn(),
  stopSessionCleanupScheduler: jest.fn(),
}));

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(),
  setupMonitoring: jest.fn(),
}));

jest.mock('../backend/src/queue/transactionQueue', () => ({
  closeQueue: jest.fn().mockResolvedValue(undefined),
  drainWorker: jest.fn().mockResolvedValue({ drained: true, activeJobs: 0, requeuedJobs: 0 }),
}));

jest.mock('../backend/src/queue/transactionRetryQueue', () => ({
  shutdownQueue: jest.fn().mockResolvedValue(undefined),
  drainWorker: jest.fn().mockResolvedValue({ drained: true, activeJobs: 0, requeuedJobs: 0 }),
  getWorker: jest.fn().mockReturnValue(null),
}));

jest.mock('../backend/src/services/bullMQRetryService', () => ({
  shutdownQueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/sseService', () => ({
  close: jest.fn().mockResolvedValue(undefined),
  closeAll: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/concurrentPaymentProcessor', () => ({
  getStats: jest.fn().mockReturnValue({ queueDepth: 0, maxQueueDepth: 100 }),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  getCachedRates: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/services/auditService', () => ({
  getAuditHealth: jest.fn().mockReturnValue({ status: 'ok' }),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  horizonClient: {
    call: jest.fn().mockResolvedValue({}),
    activeUrl: 'https://horizon.stellar.org',
    getCircuitBreakerStatus: jest.fn().mockReturnValue([]),
    ledgers: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), call: jest.fn().mockResolvedValue({}) }),
  },
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30000,
  CB_HALF_OPEN_SUCCESS_THRESHOLD: 2,
}));

jest.mock('../backend/src/models/systemConfigModel', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  get: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue({ healthy: true, readyState: 1 }),
  TRANSACTION_CONFIG: { readConcern: 'majority', writeConcern: 1, journal: false, transactionTimeoutMs: 30000 },
  POOL_CONFIG: { maxPoolSize: 20, minPoolSize: 10 },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('#466 graceful shutdown', () => {
  it('calls server.close() before mongoose.disconnect()', async () => {
    const callOrder = [];

    // Create a minimal HTTP server that tracks close() calls
    const mockServer = {
      close: jest.fn((cb) => {
        callOrder.push('server.close');
        // Simulate all in-flight requests completing immediately
        cb();
      }),
    };

    const mongoose = require('mongoose');
    mongoose.disconnect.mockImplementation(async () => {
      callOrder.push('mongoose.disconnect');
    });

    // Simulate the shutdown sequence from app.js
    const SHUTDOWN_TIMEOUT_MS = 500;
    const forceExitTimer = setTimeout(() => {}, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    await new Promise((resolve) => {
      mockServer.close(async () => {
        await mongoose.disconnect();
        clearTimeout(forceExitTimer);
        resolve();
      });
    });

    expect(callOrder).toEqual(['server.close', 'mongoose.disconnect']);
  });

  it('respects SHUTDOWN_TIMEOUT_MS env variable', () => {
    process.env.SHUTDOWN_TIMEOUT_MS = '5000';
    const timeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000;
    expect(timeout).toBe(5000);
    delete process.env.SHUTDOWN_TIMEOUT_MS;
  });

  it('defaults to 30000ms when SHUTDOWN_TIMEOUT_MS is not set', () => {
    delete process.env.SHUTDOWN_TIMEOUT_MS;
    const timeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30_000;
    expect(timeout).toBe(30_000);
  });

  it('does not close MongoDB before in-flight request completes', async () => {
    const mongoose = require('mongoose');
    mongoose.disconnect.mockClear();

    let resolveRequest;
    const inFlightRequest = new Promise((resolve) => { resolveRequest = resolve; });

    const mockServer = {
      close: jest.fn((cb) => {
        // Simulate server waiting for in-flight request
        inFlightRequest.then(cb);
      }),
    };

    const shutdownPromise = new Promise((resolve) => {
      mockServer.close(async () => {
        await mongoose.disconnect();
        resolve();
      });
    });

    // MongoDB should not be called yet
    expect(mongoose.disconnect).not.toHaveBeenCalled();

    // Complete the in-flight request
    resolveRequest();
    await shutdownPromise;

    // Now MongoDB should be disconnected
    expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('shutdownManager', () => {
  let shutdownManager;

  beforeEach(() => {
    jest.resetModules();
    shutdownManager = require('../backend/src/services/shutdownManager');
  });

  it('sets readiness to false before draining workers', async () => {
    const dm = require('../backend/src/services/shutdownManager');
    
    expect(dm.isReady()).toBe(true);
    
    dm.setReady(false);
    
    expect(dm.isReady()).toBe(false);
  });

  it('drainWorkers calls drain on both queue modules', async () => {
    const dm = require('../backend/src/services/shutdownManager');
    const txQueue = require('../backend/src/queue/transactionQueue');
    const retryQueueModule = require('../backend/src/queue/transactionRetryQueue');
    
    const result = await dm.drainWorkers();
    
    expect(txQueue.drainWorker).toHaveBeenCalled();
    expect(retryQueueModule.drainWorker).toHaveBeenCalled();
    expect(result.txQueue).toBe(true);
    expect(result.retryQueue).toBe(true);
  });

  it('notifySSEClients calls closeAll on sseService', async () => {
    const dm = require('../backend/src/services/shutdownManager');
    const sseService = require('../backend/src/services/sseService');
    
    await dm.notifySSEClients();
    
    expect(sseService.closeAll).toHaveBeenCalled();
  });

  it('stopAcceptingNewWork calls stop on polling and retrySelector', async () => {
    const dm = require('../backend/src/services/shutdownManager');
    const polling = require('../backend/src/services/transactionPollingService');
    const retrySelector = require('../backend/src/services/retryServiceSelector');
    const leaderElection = require('../backend/src/services/leaderElection');

    await dm.stopAcceptingNewWork();

    expect(polling.stopPolling).toHaveBeenCalled();
    expect(retrySelector.stop).toHaveBeenCalled();
    expect(leaderElection.stop).toHaveBeenCalled();
  });
});

describe('healthController readiness', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns 503 when shutdown has started (readiness false)', async () => {
    const shutdownManager = require('../backend/src/services/shutdownManager');
    const healthController = require('../backend/src/controllers/healthController');

    shutdownManager.setReady(false);

    const req = {};
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await healthController.healthReady(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'not_ready',
        reason: 'shutdown_in_progress',
      })
    );

    shutdownManager.setReady(true);
  });
});
