'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const request = require('supertest');

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn(),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
  findOne: jest.fn().mockResolvedValue({
    studentId: 'STU001',
    name: 'Alice',
    class: 'Grade 5A',
    feeAmount: 250,
    fees: [],
  }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'SCH001',
      name: 'Test School',
      slug: 'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD',
      isActive: true,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne: jest.fn().mockResolvedValue({ feeAmount: 250 }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  findOne: jest.fn().mockResolvedValue(null),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/disputeModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments: jest.fn(),
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

jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(),
  stopReminderScheduler: jest.fn(),
  processReminders: jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments: jest.fn().mockResolvedValue(undefined),
  syncPaymentsForSchool: jest.fn().mockResolvedValue(undefined),
  verifyTransaction: jest.fn().mockResolvedValue({}),
  recordPayment: jest.fn().mockResolvedValue({}),
  finalizeConfirmedPayments: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) => Promise.resolve(p)),
  _getRates: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: { transactions: jest.fn(), ledgers: jest.fn() },
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  isAcceptedAsset: jest.fn((code) => ({ accepted: ['XLM', 'USDC'].includes(code) })),
  ACCEPTED_ASSETS: {
    XLM: { code: 'XLM', type: 'native', displayName: 'Stellar Lumens' },
    USDC: { code: 'USDC', type: 'credit_alphanum4', displayName: 'USD Coin', issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B' },
  },
  CONFIRMATION_THRESHOLD: 3,
  FINALIZATION_THRESHOLD: 10,
}));

const app = require('../backend/src/app');

const SCHOOL_HEADERS = { 'X-School-ID': 'SCH001' };

function api(method, path) {
  return request(app)[method](path).set(SCHOOL_HEADERS);
}

describe('Payment Instructions Asset Validation (#682)', () => {
  let Student;

  beforeEach(() => {
    Student = require('../backend/src/models/studentModel');
    jest.clearAllMocks();
  });

  describe('GET /api/payments/instructions/:studentId', () => {
    test('200 — returns instructions for all accepted assets when no asset parameter', async () => {
      const res = await api('get', '/api/payments/instructions/STU001');

      expect(res.status).toBe(200);
      expect(res.body.acceptedAssets).toBeDefined();
      expect(Array.isArray(res.body.acceptedAssets)).toBe(true);
      expect(res.body.acceptedAssets.length).toBeGreaterThan(0);
    });

    test('200 — returns instructions for supported asset (XLM)', async () => {
      const res = await api('get', '/api/payments/instructions/STU001?asset=XLM');

      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBeDefined();
      expect(res.body.memo).toBe('STU001');
    });

    test('200 — returns instructions for supported asset (USDC)', async () => {
      const res = await api('get', '/api/payments/instructions/STU001?asset=USDC:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');

      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBeDefined();
    });

    test('400 — rejects unsupported asset', async () => {
      const res = await api('get', '/api/payments/instructions/STU001?asset=INVALID');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ASSET_NOT_ACCEPTED');
      expect(res.body.error).toContain('not accepted');
    });

    test('400 — returns list of supported assets in error response', async () => {
      const res = await api('get', '/api/payments/instructions/STU001?asset=FAKE');

      expect(res.status).toBe(400);
      expect(res.body.supportedAssets).toBeDefined();
      expect(Array.isArray(res.body.supportedAssets)).toBe(true);
      expect(res.body.supportedAssets.length).toBeGreaterThan(0);
      expect(res.body.supportedAssets[0]).toHaveProperty('code');
      expect(res.body.supportedAssets[0]).toHaveProperty('displayName');
    });

    test('400 — rejects unsupported asset with issuer format', async () => {
      const res = await api('get', '/api/payments/instructions/STU001?asset=FAKE:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ASSET_NOT_ACCEPTED');
    });

    test('200 — accepts asset parameter with issuer (extracts code)', async () => {
      const res = await api('get', '/api/payments/instructions/STU001?asset=XLM:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B');

      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBeDefined();
    });
  });
});
