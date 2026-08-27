'use strict';

/**
 * Tests for runtime log level change — issue #456
 * Covers: POST /api/admin/log-level and GET /health logLevel field
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const jwt = require('jsonwebtoken');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  connection: {
    readyState: 1,
    close: jest.fn().mockResolvedValue(true),
    on: jest.fn(),
    db: {
      admin: jest.fn().mockReturnValue({ ping: jest.fn().mockResolvedValue(true) }),
    },
  },
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/config/database', () => ({
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  healthCheck: jest.fn().mockResolvedValue({ healthy: true, latency: 1, readyState: 1 }),
  getConnectionInfo: jest.fn().mockReturnValue({}),
  getConnection: jest.fn(),
  POOL_CONFIG: {},
  RETRY_CONFIG: {},
  TRANSACTION_CONFIG: {},
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: { serverInfo: jest.fn().mockResolvedValue({}) },
  networkPassphrase: 'Test SDF Network ; September 2015',
  SCHOOL_WALLET: null,
  StellarSdk: {},
  ACCEPTED_ASSETS: {},
  CONFIRMATION_THRESHOLD: 2,
  isAcceptedAsset: jest.fn(),
  resolveAsset: jest.fn(),
}));

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(),
  setupMonitoring: jest.fn(),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(),
  stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/transactionService', () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
}));

jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
}));

jest.mock('../backend/src/middleware/concurrentRequestHandler', () => ({
  createConcurrentRequestMiddleware: jest.fn(() => ({
    rateLimiter: jest.fn(() => (req, res, next) => next()),
    requestQueue: jest.fn(() => (req, res, next) => next()),
  })),
}));

jest.mock('../backend/src/services/concurrentPaymentProcessor', () => ({
  concurrentPaymentProcessor: { getStats: jest.fn().mockReturnValue({ queueDepth: 0, maxQueueDepth: 50 }) },
}));

jest.mock('../backend/src/models/auditLogModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

// Stub all other routes to avoid unrelated failures
jest.mock('../backend/src/routes/schoolRoutes', () => { const fn = jest.fn((req, res, next) => next && next()); fn.use = jest.fn().mockReturnThis(); fn.get = jest.fn().mockReturnThis(); fn.post = jest.fn().mockReturnThis(); fn.put = jest.fn().mockReturnThis(); fn.patch = jest.fn().mockReturnThis(); fn.delete = jest.fn().mockReturnThis(); return fn; });
jest.mock('../backend/src/routes/studentRoutes', () => { const fn = jest.fn((req, res, next) => next && next()); fn.use = jest.fn().mockReturnThis(); fn.get = jest.fn().mockReturnThis(); fn.post = jest.fn().mockReturnThis(); fn.put = jest.fn().mockReturnThis(); fn.patch = jest.fn().mockReturnThis(); fn.delete = jest.fn().mockReturnThis(); return fn; });
jest.mock('../backend/src/routes/paymentRoutes', () => { const fn = jest.fn((req, res, next) => next && next()); fn.use = jest.fn().mockReturnThis(); fn.get = jest.fn().mockReturnThis(); fn.post = jest.fn().mockReturnThis(); fn.put = jest.fn().mockReturnThis(); fn.patch = jest.fn().mockReturnThis(); fn.delete = jest.fn().mockReturnThis(); return fn; });
jest.mock('../backend/src/routes/feeRoutes', () => { const fn = jest.fn((req, res, next) => next && next()); fn.use = jest.fn().mockReturnThis(); fn.get = jest.fn().mockReturnThis(); fn.post = jest.fn().mockReturnThis(); fn.put = jest.fn().mockReturnThis(); fn.patch = jest.fn().mockReturnThis(); fn.delete = jest.fn().mockReturnThis(); return fn; });
jest.mock('../backend/src/routes/reportRoutes', () => { const fn = jest.fn((req, res, next) => next && next()); fn.use = jest.fn().mockReturnThis(); fn.get = jest.fn().mockReturnThis(); fn.post = jest.fn().mockReturnThis(); fn.put = jest.fn().mockReturnThis(); fn.patch = jest.fn().mockReturnThis(); fn.delete = jest.fn().mockReturnThis(); return fn; });
jest.mock('../backend/src/controllers/consistencyController', () => ({
  runConsistencyCheck: jest.fn((req, res) => res.json({ status: 'ok' })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function adminToken() {
  return jwt.sign({ role: 'admin', email: 'admin@test.com' }, 'test-secret', { expiresIn: '1h' });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Runtime log level — issue #456', () => {
  let app;
  let logger;

  beforeAll(() => {
    app = require('../backend/src/app');
    logger = require('../backend/src/utils/logger');
  });

  afterEach(() => {
    // Reset to INFO after each test
    logger.setLevel('info');
  });

  describe('logger.setLevel / logger.getLevel', () => {
    it('returns current level', () => {
      logger.setLevel('debug');
      expect(logger.getLevel()).toBe('debug');
    });

    it('is case-insensitive', () => {
      logger.setLevel('WARN');
      expect(logger.getLevel()).toBe('warn');
    });

    it('throws on invalid level', () => {
      expect(() => logger.setLevel('verbose')).toThrow(/invalid log level/i);
    });

    it('change takes effect immediately — debug messages suppressed at warn level', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      logger.setLevel('warn');
      logger.debug('should not appear');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('change takes effect immediately — debug messages visible at debug level', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      logger.setLevel('debug');
      logger.debug('should appear');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('POST /api/admin/log-level', () => {
    it('401 without auth token', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .send({ level: 'debug' });
      expect(res.status).toBe(401);
    });

    it('400 for invalid level', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ level: 'verbose' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_LOG_LEVEL');
    });

    it('400 when level is missing', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('200 and changes level to debug', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ level: 'debug' });
      expect(res.status).toBe(200);
      expect(res.body.current).toBe('debug');
      expect(res.body.previous).toBeDefined();
      expect(logger.getLevel()).toBe('debug');
    });

    it('200 and changes level to error', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ level: 'error' });
      expect(res.status).toBe(200);
      expect(res.body.current).toBe('error');
    });

    it('accepts level in uppercase', async () => {
      const res = await request(app)
        .post('/api/admin/log-level')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ level: 'WARN' });
      expect(res.status).toBe(200);
      expect(res.body.current).toBe('warn');
    });
  });

  describe('GET /health includes logLevel', () => {
    it('returns logLevel field', async () => {
      logger.setLevel('info');
      const res = await request(app).get('/health');
      expect(res.body).toHaveProperty('logLevel');
      expect(res.body.logLevel).toBe('info');
    });

    it('reflects runtime level change', async () => {
      logger.setLevel('debug');
      const res = await request(app).get('/health');
      expect(res.body.logLevel).toBe('debug');
    });
  });
});
