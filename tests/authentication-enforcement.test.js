'use strict';

// Set env vars BEFORE requiring app
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-key-for-authentication-tests';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'school-a', name: 'Test School', slug: 'school-a',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      isActive: true,
    }),
  }),
  find: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn(),
  syncPaymentsForSchool: jest.fn(),
  recordPayment: jest.fn(),
  finalizeConfirmedPayments: jest.fn(),
  validatePaymentWithDynamicFee: jest.fn(),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: false,
    localAmount: 0,
    currency: 'USD',
    rate: 0,
    rateTimestamp: new Date(),
  }),
  enrichPaymentWithConversion: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue({}),
  startRetryWorker: jest.fn(),
  stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/utils/memoEncryption', () => ({
  encryptMemo: jest.fn(x => x),
  isEncryptionEnabled: jest.fn(() => false),
}));

const app = require('../backend/src/app');
const cache = require('../backend/src/cache');

describe('Authentication on Protected Endpoints (#562)', () => {
  const validAdminToken = jwt.sign({ role: 'admin', email: 'admin@test.com' }, process.env.JWT_SECRET);
  const invalidToken = 'invalid.token.here';
  const nonAdminToken = jwt.sign({ role: 'user', email: 'user@test.com' }, process.env.JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
    // The auth middleware blocks an IP after 5 failed attempts (in-memory cache).
    // Since every test here fires unauthenticated requests from the same IP, clear
    // the fail-count / block state between tests so blocks don't bleed across cases.
    cache.delByPrefix('fail_count:');
    cache.delByPrefix('blocked_ip:');
  });

  describe('Student Endpoints', () => {
    test('POST /api/students should require admin auth', async () => {
      const res = await request(app)
        .post('/api/students')
        .set('X-School-Id', 'school-a')
        .send({ studentId: 'STU001', name: 'Alice', class: '5A' })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('POST /api/students should reject non-admin token', async () => {
      const res = await request(app)
        .post('/api/students')
        .set('X-School-Id', 'school-a')
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({ studentId: 'STU001', name: 'Alice', class: '5A' })
        .expect(403);

      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    test('PUT /api/students/:studentId should require admin auth', async () => {
      const res = await request(app)
        .put('/api/students/STU001')
        .set('X-School-Id', 'school-a')
        .send({ name: 'Alice Updated' })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('DELETE /api/students/:studentId should require admin auth', async () => {
      const res = await request(app)
        .delete('/api/students/STU001')
        .set('X-School-Id', 'school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('POST /api/students/:studentId/reset-payment should require admin auth', async () => {
      const res = await request(app)
        .post('/api/students/STU001/reset-payment')
        .set('X-School-Id', 'school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });
  });

  describe('Fee Structure Endpoints', () => {
    test('POST /api/fees should require admin auth', async () => {
      const res = await request(app)
        .post('/api/fees')
        .set('X-School-Id', 'school-a')
        .send({ className: 'Grade 5A', feeAmount: 250, description: 'Annual tuition' })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('PUT /api/fees/:className should require admin auth', async () => {
      const res = await request(app)
        .put('/api/fees/Grade%205A')
        .set('X-School-Id', 'school-a')
        .send({ feeAmount: 300 })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('DELETE /api/fees/:className should require admin auth', async () => {
      const res = await request(app)
        .delete('/api/fees/Grade%205A')
        .set('X-School-Id', 'school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });
  });

  describe('School Endpoints', () => {
    test('POST /api/schools should require admin auth', async () => {
      const res = await request(app)
        .post('/api/schools')
        .send({ name: 'New School', slug: 'new-school' })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('PATCH /api/schools/:schoolId should require admin auth', async () => {
      const res = await request(app)
        .patch('/api/schools/school-a')
        .send({ name: 'Updated School' })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('DELETE /api/schools/:schoolId should require admin auth', async () => {
      const res = await request(app)
        .delete('/api/schools/school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('PATCH /api/schools/:schoolId/deactivate should require admin auth', async () => {
      const res = await request(app)
        .patch('/api/schools/school-a/deactivate')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('PATCH /api/schools/:schoolId/activate should require admin auth', async () => {
      const res = await request(app)
        .patch('/api/schools/school-a/activate')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });
  });

  describe('Payment Endpoints', () => {
    test('POST /api/payments/sync should require admin auth', async () => {
      const res = await request(app)
        .post('/api/payments/sync')
        .set('X-School-Id', 'school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('POST /api/payments/finalize should require admin auth', async () => {
      const res = await request(app)
        .post('/api/payments/finalize')
        .set('X-School-Id', 'school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('PATCH /api/payments/:txHash/status should require admin auth', async () => {
      const res = await request(app)
        .patch('/api/payments/abc123def456/status')
        .set('X-School-Id', 'school-a')
        .send({ status: 'SUCCESS' })
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    test('GET /api/payments/retry-queue should require admin auth', async () => {
      const res = await request(app)
        .get('/api/payments/retry-queue')
        .set('X-School-Id', 'school-a')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });
  });

  describe('Valid Admin Token', () => {
    test('should allow admin to access protected endpoints', async () => {
      // Mock the service to avoid actual sync
      const { syncPaymentsForSchool } = require('../backend/src/services/stellarService');
      syncPaymentsForSchool.mockResolvedValue({
        found: 0,
        new: 0,
        matched: 0,
        unmatched: 0,
        failed: 0,
        alreadyProcessed: 0,
        failedDetails: [],
      });

      const res = await request(app)
        .post('/api/payments/sync')
        .set('X-School-Id', 'school-a')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .expect(200);

      expect(res.body.message).toBe('Sync complete');
    });
  });

  describe('Invalid Token', () => {
    test('should reject invalid token format', async () => {
      const res = await request(app)
        .post('/api/payments/sync')
        .set('X-School-Id', 'school-a')
        .set('Authorization', `Bearer ${invalidToken}`)
        .expect(401);

      expect(res.body.code).toBe('INVALID_AUTH_TOKEN');
    });
  });

  describe('Expired Token', () => {
    test('should reject expired token', async () => {
      const expiredToken = jwt.sign(
        { role: 'admin', email: 'admin@test.com' },
        process.env.JWT_SECRET,
        { expiresIn: '-1h' }
      );

      const res = await request(app)
        .post('/api/payments/sync')
        .set('X-School-Id', 'school-a')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });
  });
});
