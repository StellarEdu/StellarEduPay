'use strict';

// Set env vars BEFORE requiring app
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-key-for-cross-school-tests';

const request = require('supertest');

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
  requireSchoolAuth: () => (req, res, next) => next(),
}));

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
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockImplementation((filter = {}) => ({
    lean: () => Promise.resolve({
      schoolId: filter.schoolId || 'school-a',
      stellarAddress: filter.schoolId === 'school-b' ? 'GBBBB' : 'GAAAA',
      localCurrency: 'USD',
      isActive: true,
    }),
  })),
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

const Student = require('../backend/src/models/studentModel');
const Payment = require('../backend/src/models/paymentModel');
const app = require('../backend/src/app');

describe('Cross-School Data Isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/payments/:studentId', () => {
    test('should return 404 when student exists in a different school', async () => {
      const schoolA = { _id: 'school-a', stellarAddress: 'GAAAA' };
      const schoolB = { _id: 'school-b', stellarAddress: 'GBBBB' };

      // Student STU001 exists in School B, not School A
      Student.findOne.mockImplementation(({ schoolId, studentId }) => {
        if (schoolId === 'school-b' && studentId === 'STU001') {
          return Promise.resolve({ _id: 'stu-b-1', studentId: 'STU001', name: 'Bob', feeAmount: 250 });
        }
        return Promise.resolve(null);
      });

      const res = await request(app)
        .get('/api/payments/STU001')
        .set('X-School-Id', 'school-a')
        .expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
      expect(Student.findOne).toHaveBeenCalledWith({ schoolId: 'school-a', studentId: 'STU001' });
    });

    test('should return payments only for the requesting school', async () => {
      const schoolA = { _id: 'school-a', stellarAddress: 'GAAAA', localCurrency: 'USD' };

      Student.findOne.mockResolvedValue({
        _id: 'stu-a-1',
        studentId: 'STU001',
        name: 'Alice',
        feeAmount: 250,
      });

      const chainable = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { _id: 'pay-1', txHash: 'tx1', amount: 250, studentId: 'STU001', schoolId: 'school-a' },
        ]),
      };

      Payment.find.mockReturnValue(chainable);
      Payment.countDocuments.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/payments/STU001')
        .set('X-School-Id', 'school-a')
        .expect(200);

      // Verify the query included the schoolId filter (tenant scoping)
      expect(Payment.find).toHaveBeenCalledWith({
        schoolId: 'school-a',
        studentId: 'STU001',
        deletedAt: null,
      });
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /api/payments/:studentId/balance', () => {
    test('should return 404 when student exists in a different school', async () => {
      Student.findOne.mockImplementation(({ schoolId, studentId }) => {
        if (schoolId === 'school-b' && studentId === 'STU001') {
          return Promise.resolve({ _id: 'stu-b-1', studentId: 'STU001', feeAmount: 250 });
        }
        return Promise.resolve(null);
      });

      const res = await request(app)
        .get('/api/payments/balance/STU001')
        .set('X-School-Id', 'school-a')
        .expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
    });

    test('should include schoolId in all aggregation queries', async () => {
      const schoolA = { _id: 'school-a', stellarAddress: 'GAAAA', localCurrency: 'USD' };

      Student.findOne.mockResolvedValue({
        _id: 'stu-a-1',
        studentId: 'STU001',
        feeAmount: 250,
        fees: [{ category: 'tuition', amount: 250 }],
      });

      Payment.aggregate
        .mockResolvedValueOnce([{ _id: null, totalPaid: 250, count: 1 }]) // main aggregation
        .mockResolvedValueOnce([{ _id: 'tuition', totalPaid: 250, count: 1 }]); // category aggregation

      const res = await request(app)
        .get('/api/payments/balance/STU001')
        .set('X-School-Id', 'school-a')
        .expect(200);

      // Verify both aggregations include schoolId filter
      const calls = Payment.aggregate.mock.calls;
      expect(calls[0][0][0].$match).toEqual({ schoolId: 'school-a', studentId: 'STU001', deletedAt: null });
      expect(calls[1][0][0].$match).toEqual({
        schoolId: 'school-a',
        studentId: 'STU001',
        feeCategory: { $ne: null },
        deletedAt: null,
      });
    });

    test('should not leak category breakdown from other schools', async () => {
      const schoolA = { _id: 'school-a', stellarAddress: 'GAAAA', localCurrency: 'USD' };

      Student.findOne.mockResolvedValue({
        _id: 'stu-a-1',
        studentId: 'STU001',
        feeAmount: 250,
        fees: [{ category: 'tuition', amount: 250 }],
      });

      // Main aggregation returns correct data
      Payment.aggregate
        .mockResolvedValueOnce([{ _id: null, totalPaid: 250, count: 1 }])
        // Category aggregation should only return School A's data, not School B's
        .mockResolvedValueOnce([{ _id: 'tuition', totalPaid: 250, count: 1 }]);

      const res = await request(app)
        .get('/api/payments/balance/STU001')
        .set('X-School-Id', 'school-a')
        .expect(200);

      expect(res.body.categoryBreakdown).toHaveLength(1);
      expect(res.body.categoryBreakdown[0].category).toBe('tuition');
      expect(res.body.categoryBreakdown[0].totalPaid).toBe(250);
    });
  });

  describe('GET /api/payments/instructions/:studentId', () => {
    test('should return payment instructions for student in the requesting school', async () => {
      const schoolA = { _id: 'school-a', stellarAddress: 'GAAAA', localCurrency: 'USD' };

      Student.findOne.mockResolvedValue({
        _id: 'stu-a-1',
        studentId: 'STU001',
        name: 'Alice',
        feeAmount: 250,
      });

      const res = await request(app)
        .get('/api/payments/instructions/STU001')
        .set('X-School-Id', 'school-a')
        .expect(200);

      expect(res.body.walletAddress).toBe('GAAAA');
      expect(res.body.memo).toBe('STU001');
      expect(res.body.feeAmount).toBe(250);
    });
  });

  describe('resolveSchool middleware', () => {
    test('should reject requests without school context header', async () => {
      const res = await request(app)
        .get('/api/payments/STU001')
        .expect(400);

      expect(res.body.code).toBe('MISSING_SCHOOL_CONTEXT');
    });

    test('should attach schoolId to req from header', async () => {
      Student.findOne.mockResolvedValue({
        _id: 'stu-a-1',
        studentId: 'STU001',
        feeAmount: 250,
      });

      Payment.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });

      Payment.countDocuments.mockResolvedValue(0);

      await request(app)
        .get('/api/payments/STU001')
        .set('X-School-Id', 'school-a')
        .expect(200);

      // Verify schoolId was passed to queries
      expect(Payment.countDocuments).toHaveBeenCalledWith({
        schoolId: 'school-a',
        studentId: 'STU001',
        deletedAt: null,
      });
    });
  });
});
