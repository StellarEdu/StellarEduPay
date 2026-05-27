'use strict';

/**
 * Tests for issue #594 — DELETE /api/fees/:className orphan check
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GCICZOP346CKADPWOZ6JAQ7OCGH44UELNS3GSDXFOTSZRW6OYZZ6KSY7B';
process.env.JWT_SECRET = 'test-secret';

// ── Mocks ─────────────────────────────────────────────────────────────────────

let _studentCount = 0;
const mockStudent = { countDocuments: jest.fn(() => Promise.resolve(_studentCount)) };

jest.mock('../backend/src/models/studentModel', () => mockStudent);

let _feeDoc = null;
const mockFeeStructure = {
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(() => Promise.resolve(_feeDoc)),
  create: jest.fn(),
};
jest.mock('../backend/src/models/feeStructureModel', () => mockFeeStructure);

jest.mock('../backend/src/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: { feesAll: () => 'fees:all', feeByClass: (c) => `fee:${c}` },
  TTL: {},
}));

jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/utils/logger', () => {
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
  logger.child = jest.fn().mockReturnValue(logger);
  return logger;
});

const { deleteFeeStructure } = require('../backend/src/controllers/feeController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockReq(className, query = {}) {
  return { schoolId: 'SCH-TEST', params: { className }, query };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#594 DELETE /api/fees/:className orphan check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _feeDoc = { className: 'Grade 5A', feeAmount: 250, isActive: false };
    mockFeeStructure.findOneAndUpdate.mockResolvedValue(_feeDoc);
  });

  it('returns 409 when students with unpaid fees exist', async () => {
    _studentCount = 3;
    mockStudent.countDocuments.mockResolvedValue(3);

    const next = jest.fn();
    await deleteFeeStructure(mockReq('Grade 5A'), mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.details.affectedCount).toBe(3);
  });

  it('409 response includes count of affected students', async () => {
    _studentCount = 7;
    mockStudent.countDocuments.mockResolvedValue(7);

    const next = jest.fn();
    await deleteFeeStructure(mockReq('Grade 5A'), mockRes(), next);

    const err = next.mock.calls[0][0];
    expect(err.details.affectedCount).toBe(7);
  });

  it('deactivates when no unpaid students exist', async () => {
    _studentCount = 0;
    mockStudent.countDocuments.mockResolvedValue(0);

    const res = mockRes();
    const next = jest.fn();
    await deleteFeeStructure(mockReq('Grade 5A'), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('deactivated') }),
    );
  });

  it('deactivates with force=true even when unpaid students exist', async () => {
    _studentCount = 5;
    mockStudent.countDocuments.mockResolvedValue(5);

    const res = mockRes();
    const next = jest.fn();
    await deleteFeeStructure(mockReq('Grade 5A', { force: 'true' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('deactivated') }),
    );
  });

  it('logs affected students when force=true overrides conflict', async () => {
    _studentCount = 4;
    mockStudent.countDocuments.mockResolvedValue(4);
    const logger = require('../backend/src/utils/logger');

    await deleteFeeStructure(mockReq('Grade 5A', { force: 'true' }), mockRes(), jest.fn());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('active student obligations'),
      expect.objectContaining({ affectedStudents: 4 }),
    );
  });
});
