'use strict';

// Must set required env vars before app is loaded
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-for-student-controller-suite';

const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

const mockStudents = [
  { _id: '507f1f77bcf86cd799439011', studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false },
  { _id: '507f1f77bcf86cd799439012', studentId: 'STU002', name: 'Bob', class: '5B', feeAmount: 250, feePaid: false },
];

jest.mock('../backend/src/models/studentModel', () => {
  const chainable = { sort: jest.fn(), skip: jest.fn(), limit: jest.fn() };
  chainable.sort.mockReturnValue(chainable);
  chainable.skip.mockReturnValue(chainable);
  chainable.limit.mockResolvedValue(mockStudents);
  
  // findOne must support both `await findOne()` and `findOne().includeDeleted()`.
  // We wrap the mock so every return value gets an `includeDeleted` method attached,
  // while preserving normal mockResolvedValueOnce / mockImplementationOnce behaviour.
  const findOneMock = jest.fn();
  const _findOneImpl = (val) => {
    const p = Promise.resolve(val);
    p.includeDeleted = () => Promise.resolve(null);
    p.lean = () => Promise.resolve(val);
    return p;
  };
  findOneMock.mockImplementation(() => _findOneImpl(null));
  // Patch mockResolvedValueOnce so it also attaches includeDeleted
  const _origMRVO = findOneMock.mockResolvedValueOnce.bind(findOneMock);
  findOneMock.mockResolvedValueOnce = function (val) {
    return findOneMock.mockImplementationOnce(() => _findOneImpl(val));
  };
  return {
    create: jest.fn(),
    find: jest.fn().mockReturnValue(chainable),
    findOne: findOneMock,
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(2),
  };
});

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
      populate: jest.fn().mockResolvedValue([]),
    }),
  }),
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

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => {
  const mockFees = [
    { className: '5A', feeAmount: 200, description: 'Class 5A fees', academicYear: '2026', isActive: true },
    { className: '6B', feeAmount: 300, description: 'Class 6B fees', academicYear: '2026', isActive: true },
  ];
  return {
    create: jest.fn().mockResolvedValue(mockFees[0]),
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(mockFees) }),
    findOne: jest.fn().mockImplementation(({ className }) => {
      const fees = { '5A': mockFees[0], '6B': mockFees[1] };
      return Promise.resolve(fees[className] || null);
    }),
    findOneAndUpdate: jest.fn().mockImplementation((query, update) =>
      Promise.resolve({ className: query.className, ...update })
    ),
  };
});

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({
    available: true, localAmount: 100, currency: 'USD', rate: 0.5, rateTimestamp: new Date().toISOString(),
  }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) => Promise.resolve({ ...p, localCurrency: { available: false } })),
  _getRates: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GISSUER' },
  },
}));

jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments: jest.fn().mockResolvedValue(undefined),
  syncPaymentsForSchool: jest.fn().mockResolvedValue(undefined),
  verifyTransaction: jest.fn().mockResolvedValue({}),
  recordPayment: jest.fn().mockResolvedValue({}),
  finalizeConfirmedPayments: jest.fn().mockResolvedValue(undefined),
}));

const app = require('../backend/src/app');

// Helper: supertest wrapper that always sends the X-School-ID header
function api(app) {
  const agent = request(app);
  const wrap = (method) => (...args) => {
    const req = agent[method](...args);
    return req.set('X-School-ID', 'SCH001');
  };
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), delete: wrap('delete') };
}
const testApi = api(app);

// ─── Student Controller Tests ────────────────────────────────────────────────

describe('Student Controller', () => {
  let Student;

  beforeEach(() => {
    Student = require('../backend/src/models/studentModel');
    jest.clearAllMocks();
  });

  describe('POST /api/students - registerStudent', () => {
    test('creates a student with valid data and returns 201', async () => {
      Student.findOne.mockResolvedValueOnce(null); // no exact duplicate
      Student.findOne.mockResolvedValueOnce(null); // no fuzzy duplicate
      Student.create.mockResolvedValueOnce({
        _id: '507f1f77bcf86cd799439011',
        studentId: 'STU003',
        name: 'Charlie',
        class: '5A',
        feeAmount: 200,
        feePaid: false,
      });

      const res = await testApi.post('/api/students').send({
        studentId: 'STU003',
        name: 'Charlie',
        class: '5A',
        feeAmount: 200,
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        studentId: 'STU003',
        name: 'Charlie',
        class: '5A',
        feeAmount: 200,
      });
      expect(Student.create).toHaveBeenCalledWith(
        expect.objectContaining({
          studentId: 'STU003',
          name: 'Charlie',
          class: '5A',
          feeAmount: 200,
        })
      );
    });

    test('returns 400 when name is missing', async () => {
      const res = await testApi.post('/api/students').send({
        studentId: 'STU004',
        class: '5A',
        feeAmount: 200,
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors.some(e => e.field === 'name')).toBe(true);
    });

    test('returns 400 when class is missing', async () => {
      const res = await testApi.post('/api/students').send({
        studentId: 'STU005',
        name: 'David',
        feeAmount: 200,
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors.some(e => e.field === 'class')).toBe(true);
    });

    test('returns 400 when feeAmount is negative', async () => {
      const res = await testApi.post('/api/students').send({
        studentId: 'STU006',
        name: 'Eve',
        class: '5A',
        feeAmount: -50,
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors.some(e => e.field === 'feeAmount')).toBe(true);
    });
  });

  describe('GET /api/students - getAllStudents', () => {
    test('returns an array of students', async () => {
      const res = await testApi.get('/api/students');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('students');
      expect(Array.isArray(res.body.students)).toBe(true);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pages');
      expect(res.body.students.length).toBeGreaterThan(0);
    });

    test('supports pagination with page and limit query params', async () => {
      const res = await testApi.get('/api/students?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(Student.find).toHaveBeenCalled();
    });

    test('filters by class', async () => {
      const res = await testApi.get('/api/students?class=5A');

      expect(res.status).toBe(200);
      expect(Student.find).toHaveBeenCalledWith(
        expect.objectContaining({ class: '5A' }),
        expect.anything()
      );
    });

    test('filters by status=paid', async () => {
      const res = await testApi.get('/api/students?status=paid');

      expect(res.status).toBe(200);
      expect(Student.find).toHaveBeenCalledWith(
        expect.objectContaining({ feePaid: true }),
        expect.anything()
      );
    });

    test('filters by status=unpaid', async () => {
      const res = await testApi.get('/api/students?status=unpaid');

      expect(res.status).toBe(200);
      expect(Student.find).toHaveBeenCalledWith(
        expect.objectContaining({ feePaid: false, totalPaid: { $lte: 0 } }),
        expect.anything()
      );
    });

    test('filters by status=partial', async () => {
      const res = await testApi.get('/api/students?status=partial');

      expect(res.status).toBe(200);
      expect(Student.find).toHaveBeenCalledWith(
        expect.objectContaining({ feePaid: false, totalPaid: { $gt: 0 } }),
        expect.anything()
      );
    });

    test('returns 400 for invalid status value', async () => {
      const res = await testApi.get('/api/students?status=invalid');

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
    });

    test('filters by search (case-insensitive name/studentId match)', async () => {
      const res = await testApi.get('/api/students?search=ali');

      expect(res.status).toBe(200);
      const callArg = Student.find.mock.calls[0][0];
      expect(callArg).toHaveProperty('$or');
      expect(callArg.$or).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: expect.any(RegExp) }),
          expect.objectContaining({ studentId: expect.any(RegExp) }),
        ])
      );
    });

    test('combines class, status, and search filters', async () => {
      const res = await testApi.get('/api/students?class=5A&status=paid&search=alice');

      expect(res.status).toBe(200);
      const callArg = Student.find.mock.calls[0][0];
      expect(callArg).toMatchObject({ class: '5A', feePaid: true });
      expect(callArg).toHaveProperty('$or');
    });

    // #607 — ReDoS: special regex characters must be escaped, not thrown as SyntaxError
    test.each([
      ['(', '\\('],
      ['[', '\\['],
      ['*', '\\*'],
      ['.', '\\.'],
      ['\\', '\\\\'],
    ])('search=%s returns 200 and escapes the character to %s', async (char, escaped) => {
      const res = await testApi.get(`/api/students?search=${encodeURIComponent(char)}`);
      expect(res.status).toBe(200);
      const callArg = Student.find.mock.calls[0][0];
      const nameRegex = callArg.$or.find(c => c.name)?.name;
      expect(nameRegex).toBeInstanceOf(RegExp);
      expect(nameRegex.source).toContain(escaped);
    });

    test('search=( returns 200 with empty array, not 500', async () => {
      Student.find.mockReturnValueOnce({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });
      Student.countDocuments.mockResolvedValueOnce(0);
      const res = await testApi.get('/api/students?search=(');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('students');
    });
  });

  describe('GET /api/students/:studentId - getStudent', () => {
    test('returns a student when found', async () => {
      Student.findOne.mockResolvedValueOnce(mockStudents[0]);

      const res = await testApi.get('/api/students/STU001');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        studentId: 'STU001',
        name: 'Alice',
        class: '5A',
        feeAmount: 200,
      });
      expect(Student.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ studentId: 'STU001' })
      );
    });

    test('returns 404 for unknown student ID', async () => {
      Student.findOne.mockResolvedValueOnce(null);

      const res = await testApi.get('/api/students/UNKNOWN999');

      expect(res.status).toBe(404);
      // error handler wraps as { error: { code, message }, success: false }
      expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
    });
  });
});
