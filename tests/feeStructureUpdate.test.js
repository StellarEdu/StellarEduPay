'use strict';

/**
 * Tests for PUT /api/fees/:className with cascadeToStudents — issue #454
 */

const { updateFeeStructure } = require('../backend/src/controllers/feeController');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/feeStructureModel');
jest.mock('../backend/src/models/studentModel');
jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/models/studentFeeHistoryModel');
// The cascade path wraps its writes in a mongoose transaction; without a mock,
// mongoose.connection.startSession() has no live DB and hangs to timeout.
// Delegate to the real (backend copy) mongoose so auto-mocked models can still
// build `new mongoose.Schema`, but override startSession to a no-DB session.
jest.mock('../backend/node_modules/mongoose', () => {
  const actual = jest.requireActual('../backend/node_modules/mongoose');
  actual.connection.startSession = jest.fn().mockResolvedValue({
    withTransaction: async (fn) => { await fn(); },
    endSession: jest.fn(),
  });
  return actual;
});
jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: {
    feesAll: jest.fn().mockReturnValue('fees:all'),
    feeByClass: jest.fn((c) => `fees:class:${c}`),
  },
  TTL: { FEES: 300 },
}));
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const FeeStructure = require('../backend/src/models/feeStructureModel');
const Student = require('../backend/src/models/studentModel');
const Payment = require('../backend/src/models/paymentModel');
const StudentFeeHistory = require('../backend/src/models/studentFeeHistoryModel');
const { logAudit } = require('../backend/src/services/auditService');

// The cascade path runs `Student.find(...).session(session)` and
// `Payment.aggregate(...).session(session)`, then bulkWrite + insertMany.
// Wire the chainable .session() mocks that return the given students / totals.
function setupCascadeMocks(students, paymentTotals = []) {
  Student.find = jest.fn(() => ({ session: jest.fn().mockResolvedValue(students) }));
  Student.bulkWrite = jest.fn().mockResolvedValue({});
  Payment.aggregate = jest.fn(() => ({ session: jest.fn().mockResolvedValue(paymentTotals) }));
  StudentFeeHistory.insertMany = jest.fn().mockResolvedValue([]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(body = {}, params = {}) {
  return {
    schoolId: 'SCH-TEST',
    params: { className: 'Grade 5A', ...params },
    body,
    auditContext: { performedBy: 'admin@test.com', ipAddress: '127.0.0.1', userAgent: 'jest' },
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const mockFee = {
  _id: 'fee-id-1',
  schoolId: 'SCH-TEST',
  className: 'Grade 5A',
  feeAmount: 300,
  description: 'Updated fee',
  academicYear: '2026',
  isActive: true,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PUT /api/fees/:className — issue #454', () => {
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  it('400 when feeAmount is missing', async () => {
    const req = mockReq({});
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('404 when fee structure not found', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    const req = mockReq({ feeAmount: 300 });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('200 updates fee without cascade', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(mockFee);
    const req = mockReq({ feeAmount: 300, description: 'Updated fee', academicYear: '2026' });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(res.json).toHaveBeenCalledWith({ fee: mockFee, studentsUpdated: 0 });
    expect(Student.find).not.toHaveBeenCalled();
  });

  it('200 updates fee with cascadeToStudents: true', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(mockFee);
    // Controller runs a transactional bulkWrite over the matched students.
    const mockStudents = Array.from({ length: 5 }, (_, i) => ({
      _id: `stu-${i}`, studentId: `STU-${i}`, feeAmount: 250,
    }));
    setupCascadeMocks(mockStudents);
    const req = mockReq({ feeAmount: 300, cascadeToStudents: true });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(Student.find).toHaveBeenCalledWith(
      { schoolId: 'SCH-TEST', class: 'Grade 5A', deletedAt: null }
    );
    expect(Student.bulkWrite).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ fee: mockFee, studentsUpdated: 5 });
  });

  it('cascadeToStudents: false does not update students', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(mockFee);
    const req = mockReq({ feeAmount: 300, cascadeToStudents: false });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(Student.find).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ fee: mockFee, studentsUpdated: 0 });
  });

  it('creates audit log entry on update', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(mockFee);
    const req = mockReq({ feeAmount: 300 });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fee_update',
      targetType: 'fee',
      targetId: 'Grade 5A',
      result: 'success',
    }));
  });

  it('includes academicYear in update when provided', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(mockFee);
    const req = mockReq({ feeAmount: 300, academicYear: '2027' });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(FeeStructure.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ academicYear: '2027' }),
      expect.any(Object)
    );
  });

  it('audit log includes studentsUpdated count', async () => {
    FeeStructure.findOneAndUpdate = jest.fn().mockResolvedValue(mockFee);
    const mockStudents = Array.from({ length: 3 }, (_, i) => ({
      _id: `stu-${i}`, studentId: `STU-${i}`, feeAmount: 250,
    }));
    setupCascadeMocks(mockStudents);
    const req = mockReq({ feeAmount: 300, cascadeToStudents: true });
    const res = mockRes();
    await updateFeeStructure(req, res, next);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ studentsUpdated: 3, cascadeToStudents: true }),
    }));
  });
});
