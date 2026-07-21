'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

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
  // findOne must support both `await findOne()` and `findOne().includeDeleted()/.lean()`.
  findOne: jest.fn().mockImplementation(() => {
    const p = Promise.resolve(null);
    p.includeDeleted = () => Promise.resolve(null);
    p.lean = () => Promise.resolve(null);
    return p;
  }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  insertMany: jest.fn().mockResolvedValue([]),
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
      maxStudents: 10,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockResolvedValue([]),
    lean: jest.fn().mockResolvedValue([{ className: 'Grade 5A', feeAmount: 250, isActive: true }]),
  }),
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

jest.mock('../backend/src/utils/generateStudentId', () => ({
  generateStudentId: jest.fn().mockResolvedValue('STU001'),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
  requireAuth: (req, res, next) => next(),
  requireSchoolAuth: () => (req, res, next) => next(),
}));

const app = require('../backend/src/app');

const SCHOOL_HEADERS = { 'X-School-ID': 'SCH001' };

function api(method, path) {
  return request(app)[method](path).set(SCHOOL_HEADERS);
}

describe('Student Quota (#680)', () => {
  let Student, School;

  beforeEach(() => {
    Student = require('../backend/src/models/studentModel');
    School = require('../backend/src/models/schoolModel');
    jest.clearAllMocks();
  });

  describe('POST /api/students — register student', () => {
    test('201 — creates student when under quota', async () => {
      Student.countDocuments.mockResolvedValueOnce(5);
      Student.findOne.mockResolvedValueOnce(null);
      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ schoolId: 'SCH001', maxStudents: 10, isActive: true }),
      });
      Student.create.mockResolvedValueOnce({
        studentId: 'STU001',
        name: 'Alice',
        class: 'Grade 5A',
        feeAmount: 250,
        toObject: () => ({ studentId: 'STU001', name: 'Alice', class: 'Grade 5A', feeAmount: 250 }),
      });

      const res = await api('post', '/api/students').send({
        studentId: 'STU001',
        name: 'Alice',
        class: 'Grade 5A',
      });

      expect(res.status).toBe(201);
      expect(res.body.studentId).toBe('STU001');
    });

    test('403 — rejects when at quota', async () => {
      Student.countDocuments.mockResolvedValueOnce(10);
      Student.findOne.mockResolvedValueOnce(null);
      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ schoolId: 'SCH001', maxStudents: 10, isActive: true }),
      });

      const res = await api('post', '/api/students').send({
        studentId: 'STU011',
        name: 'Bob',
        class: 'Grade 5A',
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('STUDENT_QUOTA_EXCEEDED');
    });

    test('403 — rejects when exceeding quota', async () => {
      Student.countDocuments.mockResolvedValueOnce(15);
      Student.findOne.mockResolvedValueOnce(null);
      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ schoolId: 'SCH001', maxStudents: 10, isActive: true }),
      });

      const res = await api('post', '/api/students').send({
        studentId: 'STU016',
        name: 'Charlie',
        class: 'Grade 5A',
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('STUDENT_QUOTA_EXCEEDED');
    });
  });

  describe('POST /api/students/bulk — bulk import', () => {
    test('201 — imports all students when under quota', async () => {
      Student.countDocuments.mockResolvedValueOnce(0);
      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ schoolId: 'SCH001', maxStudents: 100, isActive: true }),
      });
      Student.insertMany.mockResolvedValueOnce([
        { studentId: 'STU001', name: 'Alice', class: 'Grade 5A', feeAmount: 250 },
        { studentId: 'STU002', name: 'Bob', class: 'Grade 5A', feeAmount: 250 },
      ]);

      const res = await api('post', '/api/students/bulk').send({
        students: [
          { studentId: 'STU001', name: 'Alice', class: 'Grade 5A' },
          { studentId: 'STU002', name: 'Bob', class: 'Grade 5A' },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.created).toBe(2);
      expect(res.body.failed).toBe(0);
    });

    test('201 — partial import when spanning quota boundary', async () => {
      Student.countDocuments.mockResolvedValueOnce(8);
      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ schoolId: 'SCH001', maxStudents: 10, isActive: true }),
      });
      Student.insertMany.mockResolvedValueOnce([
        { studentId: 'STU009', name: 'Alice', class: 'Grade 5A', feeAmount: 250 },
        { studentId: 'STU010', name: 'Bob', class: 'Grade 5A', feeAmount: 250 },
      ]);

      const res = await api('post', '/api/students/bulk').send({
        students: [
          { studentId: 'STU009', name: 'Alice', class: 'Grade 5A' },
          { studentId: 'STU010', name: 'Bob', class: 'Grade 5A' },
          { studentId: 'STU011', name: 'Charlie', class: 'Grade 5A' },
          { studentId: 'STU012', name: 'Diana', class: 'Grade 5A' },
        ],
      });

      expect(res.body.created).toBe(2);
      expect(res.body.failed).toBe(2);
      expect(res.body.details.some(d => d.code === 'STUDENT_QUOTA_EXCEEDED')).toBe(true);
    });
  });
});
