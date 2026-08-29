'use strict';

/**
 * Tests for issues #587, #588, #589, #590
 * Tests the controller functions and source files directly (no app.js load needed).
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const fs = require('fs');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() {
      this.index = jest.fn();
      this.virtual = jest.fn().mockReturnValue({ get: jest.fn() });
      this.pre = jest.fn();
      this.post = jest.fn();
    }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  create: jest.fn(),
  countDocuments: jest.fn().mockResolvedValue(1),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn(),
  findOne: jest.fn().mockResolvedValue(null),
  aggregate: jest.fn().mockResolvedValue([]),
  updateMany: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: { student: (id) => `student:${id}`, studentsAll: () => 'students:all' },
  TTL: { STUDENT: 60 },
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('csv-parser', () => jest.fn(), { virtual: true });

jest.mock('../backend/src/utils/generateStudentId', () => ({
  generateStudentId: jest.fn().mockResolvedValue('STU-AUTO'),
}));

jest.mock('../backend/src/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  log.child = () => log;
  log.logger = log;
  return log;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockStudent = {
  schoolId: 'SCH001', studentId: 'STU001', name: 'Alice', class: '5A',
  feeAmount: 200, feePaid: false, totalPaid: 0, remainingBalance: 200,
  walletAddress: 'GXXX', contactEmail: 'alice@example.com', parentPhone: '+1234567890',
};

const makeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (overrides = {}) => ({
  schoolId: 'SCH001',
  admin: { role: 'admin' },
  params: {},
  query: {},
  body: {},
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// #587 — unique sparse index on txHash
// ─────────────────────────────────────────────────────────────────────────────

describe('#587 paymentModel txHash unique sparse index', () => {
  it('declares a unique sparse index on txHash', () => {
    const src = fs.readFileSync(require.resolve('../backend/src/models/paymentModel.js'), 'utf8');
    expect(src).toMatch(/paymentSchema\.index\(\s*\{\s*txHash\s*:\s*1\s*\}/);
    expect(src).toMatch(/unique\s*:\s*true/);
    expect(src).toMatch(/sparse\s*:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #588 — reconcileStudent controller
// ─────────────────────────────────────────────────────────────────────────────

describe('#588 reconcileStudent controller', () => {
  let reconcileStudent;
  let Student;
  let Payment;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ reconcileStudent } = require('../backend/src/controllers/studentController'));
    Student = require('../backend/src/models/studentModel');
    Payment = require('../backend/src/models/paymentModel');
  });

  it('returns reconciled:false when stored totalPaid matches computed sum', async () => {
    Student.findOne.mockResolvedValue({ ...mockStudent, totalPaid: 150, save: jest.fn() });
    Payment.aggregate.mockResolvedValue([{ _id: null, computedTotal: 150 }]);

    const req = makeReq({ params: { studentId: 'STU001' } });
    const res = makeRes();
    const next = jest.fn();

    await reconcileStudent(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reconciled: false, storedTotal: 150, computedTotal: 150, diff: 0,
    }));
  });

  it('corrects drift and returns reconciled:true when totals differ', async () => {
    const saveMock = jest.fn().mockResolvedValue(true);
    Student.findOne.mockResolvedValue({
      ...mockStudent, totalPaid: 100, remainingBalance: 100, feePaid: false, save: saveMock,
    });
    Payment.aggregate.mockResolvedValue([{ _id: null, computedTotal: 150 }]);

    const req = makeReq({ params: { studentId: 'STU001' } });
    const res = makeRes();
    const next = jest.fn();

    await reconcileStudent(req, res, next);

    expect(saveMock).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reconciled: true, storedTotal: 100, computedTotal: 150, diff: 50,
    }));
  });

  it('treats no payments as computedTotal=0 and corrects drift', async () => {
    const saveMock = jest.fn().mockResolvedValue(true);
    Student.findOne.mockResolvedValue({ ...mockStudent, totalPaid: 50, save: saveMock });
    Payment.aggregate.mockResolvedValue([]);

    const req = makeReq({ params: { studentId: 'STU001' } });
    const res = makeRes();
    const next = jest.fn();

    await reconcileStudent(req, res, next);

    expect(saveMock).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reconciled: true, computedTotal: 0,
    }));
  });

  it('calls next with NOT_FOUND error when student does not exist', async () => {
    Student.findOne.mockResolvedValue(null);

    const req = makeReq({ params: { studentId: 'UNKNOWN' } });
    const res = makeRes();
    const next = jest.fn();

    await reconcileStudent(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #589 — MongoDB connection pool configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('#589 MongoDB connection pool config', () => {
  it('database.js references MONGODB_POOL_SIZE with default 20', () => {
    const src = fs.readFileSync(require.resolve('../backend/src/config/database.js'), 'utf8');
    expect(src).toMatch(/MONGODB_POOL_SIZE/);
    expect(src).toMatch(/'20'/);
  });

  it('database.js includes serverSelectionTimeoutMS defaulting to 5000', () => {
    const src = fs.readFileSync(require.resolve('../backend/src/config/database.js'), 'utf8');
    expect(src).toMatch(/serverSelectionTimeoutMS/);
    expect(src).toMatch(/'5000'/);
  });

  it('database.js includes socketTimeoutMS defaulting to 45000', () => {
    const src = fs.readFileSync(require.resolve('../backend/src/config/database.js'), 'utf8');
    expect(src).toMatch(/socketTimeoutMS/);
    expect(src).toMatch(/'45000'/);
  });

  it('MONGODB_POOL_SIZE is documented in backend/.env.example', () => {
    const src = fs.readFileSync(require.resolve('../backend/.env.example'), 'utf8');
    expect(src).toMatch(/MONGODB_POOL_SIZE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #590 — PII field projection for unauthenticated GET /api/students
// ─────────────────────────────────────────────────────────────────────────────

describe('#590 GET /api/students PII projection', () => {
  let getAllStudents;
  let Student;

  const makeChain = (docs) => {
    const c = { sort: jest.fn(), skip: jest.fn(), limit: jest.fn() };
    c.sort.mockReturnValue(c); c.skip.mockReturnValue(c); c.limit.mockResolvedValue(docs);
    return c;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    ({ getAllStudents } = require('../backend/src/controllers/studentController'));
    Student = require('../backend/src/models/studentModel');
    Student.countDocuments.mockResolvedValue(1);
  });

  it('studentController source applies PII exclusion for unauthenticated callers', () => {
    const src = fs.readFileSync(
      require.resolve('../backend/src/controllers/studentController.js'), 'utf8'
    );
    expect(src).toMatch(/req\.admin/);
    expect(src).toMatch(/walletAddress\s*:\s*0/);
    expect(src).toMatch(/contactEmail\s*:\s*0/);
    expect(src).toMatch(/parentPhone\s*:\s*0/);
  });

  it('authenticated admin: find() called with empty projection {}', async () => {
    Student.find.mockReturnValue(makeChain([mockStudent]));

    const req = makeReq({ query: {} }); // req.admin is set
    const res = makeRes();
    await getAllStudents(req, res, jest.fn());

    expect(Student.find.mock.calls[0][1]).toEqual({});
  });

  it('unauthenticated: find() called with PII exclusion projection', async () => {
    Student.find.mockReturnValue(makeChain([mockStudent]));

    const req = makeReq({ query: {} });
    delete req.admin; // simulate unauthenticated
    const res = makeRes();
    await getAllStudents(req, res, jest.fn());

    expect(Student.find.mock.calls[0][1]).toEqual({
      walletAddress: 0, contactEmail: 0, parentPhone: 0,
    });
  });
});
