'use strict';

/**
 * Tests for payment verification idempotency
 * Verifies that repeated verification requests return cached results
 */

// Set required env vars before loading modules
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const request = require('supertest');

// Mock dependencies
jest.mock('../backend/src/config/database', () => ({
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
  TRANSACTION_CONFIG: {
    readConcern: 'majority',
    writeConcern: 'majority',
    journal: true,
    transactionTimeoutMs: 30000,
  },
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  // Fresh verify path computes cumulative fee via aggregate (#846).
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn(),
  // Fresh verify path updates the student's running totals (#846).
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn(),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn(),
  recordPayment: jest.fn().mockResolvedValue({}),
}));

// logAudit writes to the (real, unmocked) AuditLog model, whose queries buffer
// forever without a DB connection and hang the request. Stub the audit service —
// these tests are about verification idempotency, not the audit trail.
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0, page: 1, limit: 50, pages: 1 }),
  getRecentAuditLogs: jest.fn().mockResolvedValue([]),
  verifyAuditChain: jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  getAuditFailureCount: jest.fn().mockReturnValue(0),
}));

// The /verify route now runs the request-level idempotency middleware, which is
// backed by idempotencyStore (Redis → Mongo). With no DB connection the real
// store would buffer a Mongo query forever, so stub it as a pass-through: every
// request gets a fresh reservation and proceeds to the verify controller, whose
// own Payment-record cache is what these tests exercise.
// The fresh verify path acquires a distributed lock (Redis-backed). Without a
// connection the real lock would hang, so stub it to always grant the lock.
jest.mock('../backend/src/services/distributedLock', () => ({
  acquire: jest.fn().mockResolvedValue('lock-token'),
  release: jest.fn().mockResolvedValue(true),
  renew: jest.fn().mockResolvedValue(true),
  withLock: jest.fn(async (_key, _ttl, fn) => fn()),
  getCurrentFence: jest.fn().mockResolvedValue(0),
  close: jest.fn().mockResolvedValue(true),
}));

jest.mock('../backend/src/services/idempotencyStore', () => ({
  getFull: jest.fn().mockResolvedValue(null),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
  reserve: jest.fn().mockResolvedValue({ reserved: true }),
  complete: jest.fn().mockResolvedValue(true),
  release: jest.fn().mockResolvedValue(true),
  redisEnabled: false,
  IN_FLIGHT_TTL_MS: 30000,
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: true,
    localAmount: 1200.0,
    currency: 'USD',
    rate: 12.0,
    rateTimestamp: new Date().toISOString(),
  }),
}));

const Payment = require('../backend/src/models/paymentModel');
const Student = require('../backend/src/models/studentModel');
const School = require('../backend/src/models/schoolModel');
const PaymentIntent = require('../backend/src/models/paymentIntentModel');
const { verifyTransaction } = require('../backend/src/services/stellarService');

describe('Payment Verification Idempotency', () => {
  let app;

  beforeAll(() => {
    // Load app after mocks are set up
    app = require('../backend/src/app');
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default school mock. resolveSchool calls School.findOne({...}).lean(),
    // so return a chainable whose .lean() resolves to the (active) school.
    School.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        schoolId: 'SCH001',
        stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        localCurrency: 'USD',
        isActive: true,
      }),
    });
  });

  describe('First verification (fresh)', () => {
    test('returns cached: false for new transaction', async () => {
      const txHash = 'a1b2c3d4e5f6071829304a5b6c7d8e9f00112233445566778899aabbccddeeff';

      // No existing payment
      Payment.findOne.mockResolvedValue(null);

      // Mock student
      Student.findOne.mockResolvedValue({
        studentId: 'STU001',
        feeAmount: 100,
      });

      // Mock payment intent
      PaymentIntent.findOne.mockResolvedValue({
        memo: 'STU001',
        studentId: 'STU001',
        amount: 100,
        status: 'pending',
      });

      // Mock Horizon verification
      verifyTransaction.mockResolvedValue({
        hash: txHash,
        memo: 'STU001',
        studentId: 'STU001',
        amount: 100,
        assetCode: 'XLM',
        assetType: 'native',
        feeAmount: 100,
        feeValidation: {
          status: 'valid',
          message: 'Payment matches required fee',
          excessAmount: 0,
        },
        networkFee: 0.00001,
        date: new Date().toISOString(),
        senderAddress: 'GSENDER',
        ledger: 12345,
      });

      // Mock payment creation
      Payment.create.mockResolvedValue({
        txHash,
        studentId: 'STU001',
        amount: 100,
      });

      const response = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);

      expect(response.body).toMatchObject({
        verified: true,
        cached: false,
        hash: txHash,
        memo: 'STU001',
        studentId: 'STU001',
        amount: 100,
      });

      // Verify Horizon was called (schoolId is passed for tenant-scoped lookup, #845)
      expect(verifyTransaction).toHaveBeenCalledWith(
        txHash,
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        'SCH001'
      );
    });
  });

  describe('Second verification (cached)', () => {
    test('returns cached: true for existing payment', async () => {
      const txHash = 'b1b2c3d4e5f6071829304a5b6c7d8e9f00112233445566778899aabbccddee01';

      // Existing payment in database
      Payment.findOne.mockResolvedValue({
        txHash,
        studentId: 'STU001',
        memo: 'STU001',
        amount: 100,
        assetCode: 'XLM',
        assetType: 'native',
        feeAmount: 100,
        feeValidationStatus: 'valid',
        excessAmount: 0,
        status: 'SUCCESS',
        confirmationStatus: 'confirmed',
        confirmedAt: new Date(),
        createdAt: new Date(),
      });

      const response = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);

      expect(response.body).toMatchObject({
        verified: true,
        cached: true,
        hash: txHash,
        memo: 'STU001',
        studentId: 'STU001',
        amount: 100,
        status: 'SUCCESS',
        confirmationStatus: 'confirmed',
      });

      // Verify Horizon was NOT called
      expect(verifyTransaction).not.toHaveBeenCalled();
    });

    test('includes all payment details in cached response', async () => {
      const txHash = 'c1b2c3d4e5f6071829304a5b6c7d8e9f00112233445566778899aabbccddee02';

      Payment.findOne.mockResolvedValue({
        txHash,
        studentId: 'STU002',
        memo: 'STU002',
        amount: 200.5,
        assetCode: 'XLM',
        assetType: 'native',
        feeAmount: 200,
        feeValidationStatus: 'overpaid',
        excessAmount: 0.5,
        status: 'SUCCESS',
        confirmationStatus: 'confirmed',
        networkFee: 0.00001,
        confirmedAt: new Date('2024-03-30T10:00:00Z'),
        createdAt: new Date('2024-03-30T10:00:00Z'),
      });

      const response = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);

      expect(response.body).toMatchObject({
        verified: true,
        cached: true,
        hash: txHash,
        memo: 'STU002',
        studentId: 'STU002',
        amount: 200.5,
        assetCode: 'XLM',
        assetType: 'native',
        feeAmount: 200,
        feeValidation: {
          status: 'overpaid',
          excessAmount: 0.5,
        },
        status: 'SUCCESS',
        confirmationStatus: 'confirmed',
      });

      expect(response.body.localCurrency).toBeDefined();
      expect(response.body.stellarExplorerUrl).toBeDefined();
    });
  });

  describe('Multiple verification attempts', () => {
    test('first call is fresh, subsequent calls are cached', async () => {
      const txHash = 'd1b2c3d4e5f6071829304a5b6c7d8e9f00112233445566778899aabbccddee03';

      // First call - no existing payment
      Payment.findOne.mockResolvedValueOnce(null);

      Student.findOne.mockResolvedValue({
        studentId: 'STU003',
        feeAmount: 150,
      });

      PaymentIntent.findOne.mockResolvedValue({
        memo: 'STU003',
        studentId: 'STU003',
        amount: 150,
        status: 'pending',
      });

      verifyTransaction.mockResolvedValue({
        hash: txHash,
        memo: 'STU003',
        studentId: 'STU003',
        amount: 150,
        assetCode: 'XLM',
        assetType: 'native',
        feeAmount: 150,
        feeValidation: {
          status: 'valid',
          excessAmount: 0,
        },
        date: new Date().toISOString(),
      });

      Payment.create.mockResolvedValue({ txHash });

      // First verification
      const response1 = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);

      expect(response1.body.cached).toBe(false);
      expect(verifyTransaction).toHaveBeenCalledTimes(1);

      // Second call - payment now exists
      Payment.findOne.mockResolvedValue({
        txHash,
        studentId: 'STU003',
        memo: 'STU003',
        amount: 150,
        assetCode: 'XLM',
        assetType: 'native',
        feeAmount: 150,
        feeValidationStatus: 'valid',
        excessAmount: 0,
        status: 'SUCCESS',
        confirmationStatus: 'confirmed',
        confirmedAt: new Date(),
      });

      // Second verification
      const response2 = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);

      expect(response2.body.cached).toBe(true);
      expect(verifyTransaction).toHaveBeenCalledTimes(1); // Still only called once

      // Third verification
      const response3 = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);

      expect(response3.body.cached).toBe(true);
      expect(verifyTransaction).toHaveBeenCalledTimes(1); // Still only called once
    });
  });

  describe('Performance', () => {
    test('cached response is faster than fresh verification', async () => {
      const txHash = 'e1b2c3d4e5f6071829304a5b6c7d8e9f00112233445566778899aabbccddee04';

      // Simulate slow Horizon call
      verifyTransaction.mockImplementation(() => {
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              hash: txHash,
              memo: 'STU004',
              amount: 100,
              feeValidation: { status: 'valid' },
            });
          }, 200); // 200ms delay
        });
      });

      Payment.findOne.mockResolvedValue({
        txHash,
        studentId: 'STU004',
        memo: 'STU004',
        amount: 100,
        feeValidationStatus: 'valid',
        status: 'SUCCESS',
        confirmationStatus: 'confirmed',
        confirmedAt: new Date(),
      });

      const start = Date.now();
      await request(app)
        .post('/api/payments/verify')
        .set('X-School-Id', 'SCH001')
        .set('Idempotency-Key', `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`)
        .send({ txHash })
        .expect(200);
      const duration = Date.now() - start;

      // Cached response should be much faster (< 100ms)
      expect(duration).toBeLessThan(100);
      expect(verifyTransaction).not.toHaveBeenCalled();
    });
  });
});
