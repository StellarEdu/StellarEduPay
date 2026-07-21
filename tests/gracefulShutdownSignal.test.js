'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('SIGTERM graceful shutdown', () => {
  let mockServer;
  let processExitSpy;
  let mongoose;
  let closeQueue;
  let shutdownQueue;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');

    mockServer = {
      close: jest.fn(),
    };

    jest.doMock('express', () => {
      const expressApp = {
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        set: jest.fn(),
        listen: jest.fn(() => mockServer),
      };
      const mockRouter = {
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        patch: jest.fn(),
      };
      const express = jest.fn(() => expressApp);
      express.json = jest.fn(() => jest.fn());
      express.Router = jest.fn(() => mockRouter);
      express.urlencoded = jest.fn(() => jest.fn());
      express.static = jest.fn(() => jest.fn());
      return express;
    });

    jest.doMock('../backend/src/middleware/auth', () => ({
      requireAdminAuth: jest.fn((req, res, next) => next()),
      requireSchoolAuth: jest.fn(() => (req, res, next) => next()),
    }));

    jest.doMock('../backend/src/services/paymentSavedSubscribers', () => ({
      registerPaymentSavedSubscribers: jest.fn(),
    }));

    jest.doMock('../backend/src/services/transactionPollingService', () => ({
      startPolling: jest.fn(),
      stopPolling: jest.fn(),
    }));

    jest.doMock('../backend/src/services/retryServiceSelector', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      isRunning: jest.fn().mockReturnValue(false),
      useBullMQ: jest.fn().mockReturnValue(false),
    }));

    jest.doMock('../backend/src/services/consistencyScheduler', () => ({
      startConsistencyScheduler: jest.fn(),
    }));

    jest.doMock('../backend/src/services/reminderService', () => ({
      startReminderScheduler: jest.fn(),
      stopReminderScheduler: jest.fn(),
    }));

    jest.doMock('../backend/src/services/transactionQueueService', () => ({
      startWorker: jest.fn(),
      stopWorker: jest.fn().mockResolvedValue(undefined),
    }));

    jest.doMock('../backend/src/services/sessionCleanupService', () => ({
      startSessionCleanupScheduler: jest.fn(),
      stopSessionCleanupScheduler: jest.fn(),
    }));

    jest.doMock('../backend/src/services/reconciliationService', () => ({
      startReconciliationScheduler: jest.fn(),
      stopReconciliationScheduler: jest.fn(),
    }));

    jest.doMock('../backend/src/config/retryQueueSetup', () => ({
      initializeRetryQueue: jest.fn().mockResolvedValue(undefined),
      setupMonitoring: jest.fn(),
    }));

    jest.doMock('../backend/src/middleware/errorHandler', () => ({
      notFoundHandler: jest.fn((req, res, next) => next()),
      globalErrorHandler: jest.fn((err, req, res, next) => res.status(500).json({ error: err.message })),
    }));

    jest.doMock('../backend/src/middleware/requestLogger', () => ({
      requestLogger: jest.fn(() => (req, res, next) => next()),
    }));

    jest.doMock('../backend/src/middleware/concurrentRequestHandler', () => ({
      createConcurrentRequestMiddleware: jest.fn(() => ({
        rateLimiter: jest.fn(() => (req, res, next) => next()),
        requestQueue: jest.fn(() => (req, res, next) => next()),
      })),
    }));

    jest.doMock('../backend/src/controllers/consistencyController', () => ({
      runConsistencyCheck: jest.fn((req, res) => res.status(200).json({ ok: true })),
    }));

    jest.doMock('../backend/src/controllers/healthController', () => ({
      healthCheck: jest.fn((req, res) => res.status(200).json({ ok: true })),
    }));

    jest.doMock('../backend/src/routes/studentRoutes', () => ({}));
    jest.doMock('../backend/src/routes/paymentRoutes', () => ({}));
    jest.doMock('../backend/src/routes/feeRoutes', () => ({}));
    jest.doMock('../backend/src/routes/reportRoutes', () => ({}));
    jest.doMock('../backend/src/routes/schoolRoutes', () => ({}));
    jest.doMock('../backend/src/routes/reminderRoutes', () => ({}));
    jest.doMock('../backend/src/routes/disputeRoutes', () => ({}));
    jest.doMock('../backend/src/routes/sourceValidationRuleRoutes', () => ({}));
    jest.doMock('../backend/src/routes/receiptsRoutes', () => ({}));
    jest.doMock('../backend/src/routes/feeAdjustmentRoutes', () => ({}));
    jest.doMock('../backend/src/routes/adminRoutes', () => ({}));
    jest.doMock('../backend/src/routes/authRoutes', () => ({}));

    jest.doMock('../backend/src/utils/logger', () => {
      const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
      log.child = jest.fn(() => log);
      return log;
    });

    jest.doMock('../backend/src/utils/corsOrigins', () => ({
      parseAllowedOrigins: jest.fn(() => []),
    }));

    // app.js (backend/src) resolves the DUPLICATE backend/node_modules/mongoose
    // copy, so mock BOTH paths — otherwise app.js calls the real backend
    // mongoose.disconnect() (which rejects with no connection → the shutdown catch
    // calls exit(1)) while the assertion checks an unused root mock. Delegate to the
    // real mongoose (so models can build `new mongoose.Schema`/Types at load) but
    // override connect (no real DB) and disconnect (shared jest.fn to assert).
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);
    const makeMongoose = (actual) => {
      actual.connect = jest.fn().mockResolvedValue(actual);
      actual.disconnect = mockDisconnect;
      return actual;
    };
    jest.doMock('mongoose', () => makeMongoose(jest.requireActual('mongoose')));
    jest.doMock('../backend/node_modules/mongoose', () =>
      makeMongoose(jest.requireActual('../backend/node_modules/mongoose')),
    );

    jest.doMock('../backend/src/queue/transactionQueue', () => ({
      closeQueue: jest.fn().mockResolvedValue(undefined),
    }));

    jest.doMock('../backend/src/services/bullMQRetryService', () => ({
      shutdownQueue: jest.fn().mockResolvedValue(undefined),
    }));

    // shutdownManager drains/stops these lazily during shutdown; unmocked they
    // reach into real BullMQ/redis and never resolve, stalling the chain before
    // it can close the queues and disconnect.
    jest.doMock('../backend/src/queue/transactionRetryQueue', () => ({
      drainWorker: jest.fn().mockResolvedValue({}),
      closeQueue: jest.fn().mockResolvedValue(undefined),
    }));

    jest.doMock('../backend/src/services/leaderElection', () => ({
      start: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
      isLeader: jest.fn().mockReturnValue(false),
    }));

    jest.doMock('../backend/src/services/sseService', () => ({
      addClient: jest.fn(),
      removeClient: jest.fn(),
      emit: jest.fn(),
      closeAll: jest.fn().mockResolvedValue(undefined),
    }));

    mongoose = require('mongoose');
    closeQueue = require('../backend/src/queue/transactionQueue').closeQueue;
    shutdownQueue = require('../backend/src/services/bullMQRetryService').shutdownQueue;

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    processExitSpy?.mockRestore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    jest.resetModules();
    jest.clearAllMocks();
  });

  // Drain the microtask/macrotask queue until the async shutdown chain reaches
  // process.exit (bounded so a hang fails fast rather than timing out at 5s).
  async function flushUntilExit() {
    for (let i = 0; i < 50 && processExitSpy.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('SIGTERM runs a graceful shutdown: stops work, closes queues, then disconnects the DB and exits(0)', async () => {
    require('../backend/src/app');

    process.emit('SIGTERM');
    await flushUntilExit();

    // shutdownManager.closeQueues() closes both the transaction queue and the
    // BullMQ retry queue.
    expect(closeQueue).toHaveBeenCalledTimes(1);
    expect(shutdownQueue).toHaveBeenCalledTimes(1);

    // The DB is disconnected inside server.close() — i.e. only after the queues
    // have been closed — and the process exits cleanly with code 0.
    expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);

    // Ordering: queues close before the DB disconnects.
    expect(closeQueue.mock.invocationCallOrder[0]).toBeLessThan(
      mongoose.disconnect.mock.invocationCallOrder[0],
    );
    expect(shutdownQueue.mock.invocationCallOrder[0]).toBeLessThan(
      mongoose.disconnect.mock.invocationCallOrder[0],
    );
  });

  it('exits with code 0 (clean) after the DB disconnects successfully', async () => {
    require('../backend/src/app');

    process.emit('SIGINT');
    await flushUntilExit();

    expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(processExitSpy).not.toHaveBeenCalledWith(1);
  });
});
