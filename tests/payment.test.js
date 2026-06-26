'use strict';

// Must set required env vars before app is loaded (config/index.js validates on require)
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-for-payment-controller-suite';

const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
}));

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

// A valid 24-char hex MongoDB ObjectId used wherever the DB _id is required.
// Declared as a const for use in test bodies. The literal is also inlined
// inside jest.mock() factories below because Jest hoists those calls above
// const declarations, which would make the variable undefined inside the factory.
const MOCK_STUDENT_OBJ_ID = '507f1f77bcf86cd799439011';

jest.mock('../backend/src/models/studentModel', () => {
  const mockStudents = [{ _id: '507f1f77bcf86cd799439011', studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false }];
  const chainable = { sort: jest.fn(), skip: jest.fn(), limit: jest.fn() };
  chainable.sort.mockReturnValue(chainable);
  chainable.skip.mockReturnValue(chainable);
  chainable.limit.mockResolvedValue(mockStudents);
  const makeStudentQuery = (value) => {
    const p = Promise.resolve(value);
    p.includeDeleted = () => Promise.resolve(null);
    p.lean = () => Promise.resolve(value);
    return p;
  };
  const findOneMock = jest.fn().mockImplementation(() =>
    makeStudentQuery({ _id: '507f1f77bcf86cd799439011', studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false })
  );
  findOneMock.mockResolvedValueOnce = (val) => {
    findOneMock.mockImplementationOnce(() => makeStudentQuery(val));
    return findOneMock;
  };
  return {
    create: jest.fn().mockResolvedValue({ _id: '507f1f77bcf86cd799439011', studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false }),
    find: jest.fn().mockReturnValue(chainable),
    findOne: findOneMock,
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    countDocuments: jest.fn().mockResolvedValue(1),
  };
});

jest.mock('../backend/src/models/paymentModel', () => {
  const mockPayments = [
    { schoolId: 'SCH001', studentId: 'STU001', txHash: 'abc123', amount: 200, deletedAt: null },
  ];

  const matchesFilter = (payment, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      if (value !== null && typeof value === 'object') return true;
      return payment[key] === value;
    });

  const makeQuery = (docs) => {
    const chain = {
      sort: jest.fn(() => chain),
      skip: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      lean: jest.fn(() => Promise.resolve(docs)),
      populate: jest.fn(() => Promise.resolve(
        docs.map((p) => ({
          ...p,
          studentId: { studentId: p.studentId, name: 'Alice' },
        })),
      )),
    };
    return chain;
  };

  return {
    find: jest.fn((filter) => makeQuery(mockPayments.filter((p) => matchesFilter(p, filter)))),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    aggregate: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn((filter) => Promise.resolve(mockPayments.filter((p) => matchesFilter(p, filter)).length)),
    activeFilter: jest.fn((filter = {}) => ({ ...filter, deletedAt: null })),
  };
});

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create: jest.fn().mockResolvedValue({
    studentId: 'STU001', amount: 200, memo: 'ABCD1234', status: 'pending',
    toObject() { return { studentId: 'STU001', amount: 200, memo: 'ABCD1234', status: 'pending' }; },
  }),
  findOne: jest.fn().mockResolvedValue({ studentId: 'STU001', amount: 200, memo: 'ABCD1234', status: 'pending' }),
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

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/queue/transactionQueue', () => ({
  enqueueTransaction: jest.fn().mockResolvedValue({ id: 'mock-job' }),
  getJobStatus: jest.fn().mockResolvedValue({ found: false }),
}));

jest.mock('../backend/src/services/transactionQueueService', () => ({
  startWorker: jest.fn(),
  stopWorker: jest.fn(),
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

jest.mock('../backend/src/models/schoolModel', () => {
  const schools = [
    {
      schoolId: 'SCH001',
      name: 'Test School',
      slug: 'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD',
      isActive: true,
    },
    {
      schoolId: 'SCH_A',
      name: 'School A',
      slug: 'school-a',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD',
      isActive: true,
    },
    {
      schoolId: 'SCH_B',
      name: 'School B',
      slug: 'school-b',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD',
      isActive: true,
    },
  ];

  return {
    findOne: jest.fn((query) => ({
      lean: jest.fn().mockResolvedValue(
        schools.find((school) => (
          (!query.schoolId || school.schoolId === query.schoolId) &&
          (!query.slug || school.slug === query.slug) &&
          (query.isActive === undefined || school.isActive === query.isActive)
        )) || null,
      ),
    })),
    create: jest.fn().mockResolvedValue({}),
  };
});

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
  server: {
    transactions: () => ({
      transaction: (txHash) => ({
        call: async () => ({
          hash: txHash,
          successful: true,
          created_at: new Date().toISOString(),
          ledger_attr: 12345,
          memo: 'test-memo',
          fee_paid: 100,
          source_account: 'GACCOUNT',
          operation_count: 1,
        }),
      }),
    }),
  },
}));

jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments: jest.fn().mockResolvedValue(undefined),
  syncPaymentsForSchool: jest.fn().mockResolvedValue({ found: 0, new: 0, matched: 0, unmatched: 0, failed: 0, alreadyProcessed: 0, failedDetails: [] }),
  verifyTransaction: jest.fn().mockResolvedValue({
    hash: 'abc123',
    memo: 'STU001',
    studentId: 'STU001',
    amount: 200,
    assetCode: 'XLM',
    assetType: 'native',
    expectedAmount: 200,
    feeAmount: 200,
    feeValidation: { status: 'valid', excessAmount: 0, message: 'Payment matches the required fee' },
    networkFee: 0.00001,
    date: new Date().toISOString(),
    ledger: 100,
    senderAddress: 'GSENDER123',
  }),
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

function paymentQueryResult(docs) {
  const chain = {
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(docs)),
  };
  return chain;
}

// ─── Full Payment Flow ────────────────────────────────────────────────────────

describe('Full payment flow', () => {
  test('Step 1 — register student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null); // no exact duplicate
    Student.findOne.mockResolvedValueOnce(null); // no fuzzy duplicate
    const res = await testApi.post('/api/students').send({
      studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ studentId: 'STU001', feeAmount: 200 });
  });

  test('Step 2 — get payment instructions', async () => {
    const res = await testApi.get('/api/payments/instructions/STU001');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('memo', 'STU001');
    expect(res.body).toHaveProperty('note');
    expect(res.body.acceptedAssets.some(a => a.code === 'XLM')).toBe(true);
  });

  test('Step 3 — verify transaction after payment', async () => {
    const txHash = 'a'.repeat(64);
    const res = await testApi.post('/api/payments/verify')
      .set('Idempotency-Key', 'flow-verify-abc123')
      .send({ txHash });
    expect(res.status).toBe(200);
    expect(res.body.feeValidation.status).toBe('valid');
  });

  test('Step 4 — payment history reflects the transaction', async () => {
    const res = await testApi.get('/api/payments/STU001');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('payments');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('pages');
    expect(Array.isArray(res.body.payments)).toBe(true);
    expect(res.body.payments[0]).toHaveProperty('txHash', 'abc123');
  });

  test('GET /api/payments/:studentId is scoped to the current school', async () => {
    const Student = require('../backend/src/models/studentModel');
    const Payment = require('../backend/src/models/paymentModel');
    const cache = require('../backend/src/cache');
    const crossSchoolPayments = [
      { schoolId: 'SCH_A', studentId: 'STU001', txHash: 'school-a-tx', amount: 100 },
      { schoolId: 'SCH_B', studentId: 'STU001', txHash: 'school-b-tx', amount: 200 },
    ];
    const byFilter = (filter) => crossSchoolPayments.filter(
      (p) => p.schoolId === filter.schoolId && p.studentId === filter.studentId,
    );

    cache.del('school:SCH_A', 'school:SCH_B');
    Student.findOne.mockResolvedValueOnce({
      schoolId: 'SCH_A',
      studentId: 'STU001',
      name: 'Alice',
      class: '5A',
      feeAmount: 200,
    });
    Payment.countDocuments.mockImplementationOnce((filter) => Promise.resolve(byFilter(filter).length));
    Payment.find.mockImplementationOnce((filter) => paymentQueryResult(byFilter(filter)));

    const res = await request(app)
      .get('/api/payments/STU001')
      .set('X-School-ID', 'SCH_A');

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toHaveProperty('txHash', 'school-a-tx');
    expect(res.body.payments.map((p) => p.txHash)).not.toContain('school-b-tx');
    expect(Payment.countDocuments).toHaveBeenLastCalledWith({ schoolId: 'SCH_A', studentId: 'STU001', deletedAt: null });
    expect(Payment.find).toHaveBeenLastCalledWith({ schoolId: 'SCH_A', studentId: 'STU001', deletedAt: null });
  });
});

// ─── Student API ──────────────────────────────────────────────────────────────

describe('Student API', () => {
  test('POST /api/students — creates a student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null); // no exact duplicate
    Student.findOne.mockResolvedValueOnce(null); // no fuzzy duplicate
    const res = await testApi.post('/api/students').send({
      studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('studentId', 'STU001');
  });

  test('POST /api/students — 400 when name is missing', async () => {
    const res = await testApi.post('/api/students').send({ studentId: 'STU002', class: '5A', feeAmount: 200 });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.field === 'name')).toBe(true);
  });

  test('POST /api/students — 400 when class is missing', async () => {
    const res = await testApi.post('/api/students').send({ studentId: 'STU002', name: 'Bob', feeAmount: 200 });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.field === 'class')).toBe(true);
  });

  test('POST /api/students — 400 when studentId format is invalid', async () => {
    const res = await testApi.post('/api/students').send({ studentId: '!!', name: 'Bob', class: '5A' });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.field === 'studentId')).toBe(true);
  });

  test('POST /api/students — 400 when feeAmount is not a positive number', async () => {
    const res = await testApi.post('/api/students').send({ name: 'Bob', class: '5A', feeAmount: -10 });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.field === 'feeAmount')).toBe(true);
  });

  test('POST /api/students — sanitizes whitespace from name and class', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null);
    Student.findOne.mockResolvedValueOnce(null);
    const res = await testApi.post('/api/students').send({
      studentId: 'STU003', name: '  Carol  ', class: '  5A  ', feeAmount: 200,
    });
    expect(res.status).toBe(201);
  });

  test('GET /api/students — returns all students', async () => {
    const res = await testApi.get('/api/students');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.students)).toBe(true);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('pages');
  });

  test('GET /api/students/:studentId — returns a student', async () => {
    const res = await testApi.get('/api/students/STU001');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ studentId: 'STU001', feeAmount: 200 });
  });

  test('GET /api/students/:studentId — 404 for unknown student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null);
    const res = await testApi.get('/api/students/UNKNOWN');
    expect(res.status).toBe(404);
  });
});

// ─── Payment API ──────────────────────────────────────────────────────────────

describe('Payment API', () => {
  test('POST /api/payments/sync — returns success', async () => {
    const res = await testApi.post('/api/payments/sync');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Sync complete');
  });

  // #605 — sync lock tests
  describe('POST /api/payments/sync — concurrent lock', () => {
    beforeEach(() => {
      // Clear the in-memory lock set between tests by accessing it via the controller module
      const ctrl = require('../backend/src/controllers/paymentController');
      if (ctrl._syncLocks) ctrl._syncLocks.clear();
    });

    afterEach(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    test('second concurrent request returns 409 SYNC_IN_PROGRESS', async () => {
      const stellarService = require('../backend/src/services/stellarService');
      // Hold the lock open with a never-resolving promise
      stellarService.syncPaymentsForSchool.mockImplementationOnce(() => new Promise(() => {}));

      // Fire first request without awaiting — it holds the lock
      testApi.post('/api/payments/sync').end(() => {});
      await new Promise((r) => setTimeout(r, 30));

      // Second request must be rejected while lock is held
      const second = await testApi.post('/api/payments/sync');
      expect(second.status).toBe(409);
      expect(second.body).toHaveProperty('code', 'SYNC_IN_PROGRESS');
    }, 5000);

    test('lock is released after sync completes — subsequent request succeeds', async () => {
      const stellarService = require('../backend/src/services/stellarService');
      stellarService.syncPaymentsForSchool.mockResolvedValueOnce(
        { found: 0, new: 0, matched: 0, unmatched: 0, failed: 0, alreadyProcessed: 0, failedDetails: [] }
      );
      await testApi.post('/api/payments/sync');

      // After completion the lock must be gone
      stellarService.syncPaymentsForSchool.mockResolvedValueOnce(
        { found: 0, new: 0, matched: 0, unmatched: 0, failed: 0, alreadyProcessed: 0, failedDetails: [] }
      );
      const res = await testApi.post('/api/payments/sync');
      expect(res.status).toBe(200);
    });

    test('lock is released even when sync throws an error', async () => {
      const stellarService = require('../backend/src/services/stellarService');
      stellarService.syncPaymentsForSchool.mockRejectedValueOnce(new Error('Horizon down'));
      await testApi.post('/api/payments/sync'); // ignore error response

      // Lock must be cleared — next request should not get 409
      stellarService.syncPaymentsForSchool.mockResolvedValueOnce(
        { found: 0, new: 0, matched: 0, unmatched: 0, failed: 0, alreadyProcessed: 0, failedDetails: [] }
      );
      const res = await testApi.post('/api/payments/sync');
      expect(res.status).toBe(200);
    });
  });

  test('POST /api/payments/verify — returns cached result for already-recorded transaction', async () => {
    const Payment = require('../backend/src/models/paymentModel');
    const txHash = 'b'.repeat(64);
    Payment.findOne.mockResolvedValueOnce({ txHash, studentId: 'STU001', amount: 200, feeValidationStatus: 'valid' });
    const res = await testApi.post('/api/payments/verify')
      .set('Idempotency-Key', 'test-verify-dup')
      .send({ txHash });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cached', true);
    expect(res.body).toHaveProperty('hash', txHash);
  });

  test('GET /api/payments/accepted-assets — returns assets with cache headers', async () => {
    const res = await testApi.get('/api/payments/accepted-assets');
    expect(res.status).toBe(200);
    expect(res.body.assets.map(a => a.code)).toEqual(expect.arrayContaining(['XLM', 'USDC']));
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  });

  test('GET /api/payments/accepted-assets — returns 304 on matching If-None-Match', async () => {
    const first = await testApi.get('/api/payments/accepted-assets');
    const etag = first.headers['etag'];
    const second = await testApi.get('/api/payments/accepted-assets').set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });

  test('GET /api/payments/ — excludes soft-deleted payments', async () => {
    const Payment = require('../backend/src/models/paymentModel');
    Payment.find.mockClear();
    Payment.countDocuments.mockClear();

    const res = await testApi.get('/api/payments/');
    expect(res.status).toBe(200);

    // Assert the query filter includes deletedAt: null
    const findCallArgs = Payment.find.mock.calls[0][0];
    expect(findCallArgs).toHaveProperty('deletedAt', null);

    const countCallArgs = Payment.countDocuments.mock.calls[0][0];
    expect(countCallArgs).toHaveProperty('deletedAt', null);
  });
});

// ─── Fee Structure API ────────────────────────────────────────────────────────

describe('Fee Structure API', () => {
  test('POST /api/fees — creates a fee structure', async () => {
    const FeeStructure = require('../backend/src/models/feeStructureModel');
    FeeStructure.findOne.mockResolvedValueOnce(null); // no existing fee for this class
    const res = await testApi.post('/api/fees').send({ className: '5A', feeAmount: 200 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ className: '5A', feeAmount: 200 });
  });

  test('POST /api/fees — 400 when required fields missing', async () => {
    const res = await testApi.post('/api/fees').send({ description: 'No class' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  test('GET /api/fees — returns all fee structures', async () => {
    const res = await testApi.get('/api/fees');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/fees/:className — returns fee for class', async () => {
    const res = await testApi.get('/api/fees/5A');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ className: '5A', feeAmount: 200 });
  });

  test('GET /api/fees/:className — 404 for unknown class', async () => {
    const res = await testApi.get('/api/fees/UNKNOWN');
    expect(res.status).toBe(404);
  });
});

// ─── Payment Intent API ───────────────────────────────────────────────────────

describe('Payment Intent API', () => {
  test('POST /api/payments/intent — creates a payment intent', async () => {
    const res = await testApi.post('/api/payments/intent')
      .set('Idempotency-Key', 'test-intent-stu001')
      .send({ studentId: MOCK_STUDENT_OBJ_ID });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('memo');
    expect(res.body).toHaveProperty('amount', 200);
    expect(res.body).toHaveProperty('studentId', 'STU001');
  });

  test('POST /api/payments/intent — 400 for invalid studentId format', async () => {
    // 'UNKNOWN' is not a 24-char hex ObjectId — Joi must reject it before the controller
    const res = await request(app).post('/api/payments/intent').send({ studentId: 'UNKNOWN' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
    expect(res.body.errors[0]).toHaveProperty('field', 'studentId');
  });

  test('POST /api/payments/intent — 400 for amount below minimum threshold', async () => {
    const res = await request(app).post('/api/payments/intent').send({ studentId: MOCK_STUDENT_OBJ_ID, amount: 0.5 });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toHaveProperty('field', 'amount');
  });

  test('POST /api/payments/intent — 400 for unsupported currency', async () => {
    const res = await request(app).post('/api/payments/intent').send({ studentId: MOCK_STUDENT_OBJ_ID, currency: 'BTC' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toHaveProperty('field', 'currency');
  });

  test('POST /api/payments/submit — 400 when xdr is missing', async () => {
    const res = await request(app).post('/api/payments/submit').send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
    expect(res.body.errors[0]).toHaveProperty('field', 'xdr');
  });

  test('POST /api/v1/payments/intent — 404 for unknown student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null);
    const res = await testApi.post('/api/payments/intent')
      .set('Idempotency-Key', 'test-intent-unknown')
      .send({ studentId: MOCK_STUDENT_OBJ_ID });
    expect(res.status).toBe(404);
  });
});

// ─── Duplicate Student Detection ─────────────────────────────────────────────

describe('Duplicate Student Detection', () => {
  test('POST /api/students — 409 for duplicate studentId', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce({
      studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200,
    });
    const res = await testApi.post('/api/students').send({
      studentId: 'STU001', name: 'Bob', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toHaveProperty('code', 'DUPLICATE_STUDENT');
  });

  test('POST /api/students — 201 with warning for same name+class', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null); // no exact match
    Student.findOne.mockResolvedValueOnce({      // fuzzy match found
      studentId: 'STU001', name: 'Alice', class: '5A',
    });
    Student.create.mockResolvedValueOnce({
      studentId: 'STU002', name: 'Alice', class: '5A', feeAmount: 200,
      toObject() { return { studentId: 'STU002', name: 'Alice', class: '5A', feeAmount: 200 }; },
    });
    const res = await testApi.post('/api/students').send({
      studentId: 'STU002', name: 'Alice', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('warning');
    expect(res.body.warning).toMatch(/already exists/);
  });

  test('POST /api/students — 201 without warning for unique student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null); // no exact match
    Student.findOne.mockResolvedValueOnce(null); // no soft-deleted match
    Student.findOne.mockResolvedValueOnce(null); // no fuzzy match
    Student.create.mockResolvedValueOnce({
      studentId: 'STU999', name: 'Unique', class: '7A', feeAmount: 300,
    });
    const res = await testApi.post('/api/students').send({
      studentId: 'STU999', name: 'Unique', class: '7A', feeAmount: 300,
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('warning');
  });

  test('POST /api/students — 409 when MongoDB throws duplicate key error', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null); // race condition: no match found
    Student.findOne.mockResolvedValueOnce(null); // no soft-deleted match
    Student.findOne.mockResolvedValueOnce(null); // no fuzzy match
    const mongoErr = new Error('E11000 duplicate key');
    mongoErr.code = 11000;
    Student.create.mockRejectedValueOnce(mongoErr);
    const res = await testApi.post('/api/students').send({
      studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toHaveProperty('code', 'DUPLICATE_STUDENT');
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('Idempotency', () => {
  let IdempotencyKey;

  beforeEach(() => {
    IdempotencyKey = require('../backend/src/models/idempotencyKeyModel');
    IdempotencyKey.findOne.mockResolvedValue(null);
    IdempotencyKey.create.mockResolvedValue({});
  });

  test('POST /api/payments/intent — 400 when Idempotency-Key header is missing', async () => {
    const res = await testApi.post('/api/payments/intent').send({ studentId: MOCK_STUDENT_OBJ_ID });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'MISSING_IDEMPOTENCY_KEY');
  });

  test('POST /api/payments/verify — 400 when Idempotency-Key header is missing', async () => {
    const res = await testApi.post('/api/payments/verify').send({ txHash: 'abc123' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'MISSING_IDEMPOTENCY_KEY');
  });

  test('POST /api/payments/intent — returns cached response on duplicate key', async () => {
    const cachedBody = { studentId: 'STU001', amount: 200, memo: 'CACHED1', status: 'pending' };
    IdempotencyKey.findOne.mockResolvedValueOnce({
      key: 'dupe-intent-key',
      requestPath: '/intent',
      responseStatus: 201,
      responseBody: cachedBody,
    });

    const PaymentIntent = require('../backend/src/models/paymentIntentModel');
    PaymentIntent.create.mockClear();

    const res = await testApi.post('/api/payments/intent')
      .set('Idempotency-Key', 'dupe-intent-key')
      .send({ studentId: MOCK_STUDENT_OBJ_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(cachedBody);
    expect(PaymentIntent.create).not.toHaveBeenCalled();
  });

  test('POST /api/payments/verify — returns cached response on duplicate key', async () => {
    const cachedBody = { hash: 'abc123', memo: 'STU001', amount: 200, feeValidation: { status: 'valid' } };
    IdempotencyKey.findOne.mockResolvedValueOnce({
      key: 'dupe-verify-key',
      requestPath: '/verify',
      responseStatus: 200,
      responseBody: cachedBody,
    });

    const res = await testApi.post('/api/payments/verify')
      .set('Idempotency-Key', 'dupe-verify-key')
      .send({ txHash: 'a'.repeat(64) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedBody);
  });

  test('POST /api/payments/intent — caches response after first successful call', async () => {
    IdempotencyKey.create.mockClear();

    await testApi.post('/api/payments/intent')
      .set('Idempotency-Key', 'new-intent-key')
      .send({ studentId: MOCK_STUDENT_OBJ_ID });

    expect(IdempotencyKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'new-intent-key',
        requestPath: '/intent',
        responseStatus: 201,
      })
    );
  });

  test('POST /api/payments/sync — does NOT require Idempotency-Key', async () => {
    const res = await testApi.post('/api/payments/sync');
    expect(res.status).toBe(200);
  });

  test('GET /api/payments/verify/:txHash — returns transaction details', async () => {
    const txHash = 'a'.repeat(64);
    const res = await request(app).get(`/api/payments/verify/${txHash}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hash: txHash,
      successful: true,
      created_at: expect.any(String),
      ledger: 12345,
      memo: 'test-memo',
      fee_paid: 100,
      source_account: 'GACCOUNT',
      operations_count: 1,
    });
  });

  test('GET /api/payments/verify/:txHash — 400 for invalid txHash', async () => {
    const res = await request(app).get('/api/payments/verify/invalid');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe('txHash');
  });
});
