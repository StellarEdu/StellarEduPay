'use strict';

/**
 * Tests for Issue #1786 — PATCH /students/:id must recompute remainingBalance
 * and feePaid when the fee changes, record a StudentFeeHistory entry, and
 * reject invalid feeAmount values.
 */

let mockStudentFindOne;
let mockStudentFindOneAndUpdate;
let mockFeeStructureFindOne;
let mockUpdateStudentBalance;
let mockFeeHistoryCreate;

jest.mock('../src/models/studentModel', () => ({
  findOne: (...args) => mockStudentFindOne(...args),
  findOneAndUpdate: (...args) => mockStudentFindOneAndUpdate(...args),
}));
jest.mock('../src/models/feeStructureModel', () => ({
  findOne: (...args) => mockFeeStructureFindOne(...args),
}));
jest.mock('../src/models/studentFeeHistoryModel', () => ({
  create: (...args) => mockFeeHistoryCreate(...args),
}));
jest.mock('../src/utils/studentBalanceUpdater', () => ({
  updateStudentBalance: (...args) => mockUpdateStudentBalance(...args),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/services/studentPiiEncryption', () => ({
  encryptStudentPii: jest.fn((d) => d),
  decryptStudentPii: jest.fn((d) => d),
  hashParentEmail: jest.fn(),
}));
jest.mock('../src/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: {
    student: () => 'student-key',
    publicStudent: () => 'public-student-key',
  },
  TTL: {},
}));

const { updateStudent } = require('../src/controllers/studentController');

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(body) {
  return {
    schoolId: 'SCH-1',
    params: { studentId: 'STU-1' },
    body,
    auditContext: null,
  };
}

// Original student: fee 100, fully paid.
const ORIGINAL = {
  schoolId: 'SCH-1',
  studentId: 'STU-1',
  name: 'Ada',
  class: 'Grade 1',
  feeAmount: 100,
  feePaid: true,
  totalPaid: 100,
  remainingBalance: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStudentFindOne = jest.fn(() => ({ lean: () => Promise.resolve({ ...ORIGINAL }) }));
  mockFeeStructureFindOne = jest.fn();
  mockFeeHistoryCreate = jest.fn().mockResolvedValue({});
});

describe('Issue #1786 — updateStudent fee recalculation', () => {
  test('raising the fee recalculates balance, clears feePaid and writes fee history', async () => {
    const updated = { ...ORIGINAL, feeAmount: 150 };
    mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue(updated);
    const recalculated = { ...updated, feePaid: false, totalPaid: 100, remainingBalance: 50 };
    mockUpdateStudentBalance = jest.fn().mockResolvedValue(recalculated);

    const res = makeRes();
    const next = jest.fn();
    await updateStudent(makeReq({ feeAmount: 150 }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockUpdateStudentBalance).toHaveBeenCalledWith('SCH-1', 'STU-1');
    expect(res.json).toHaveBeenCalledWith(recalculated);
    expect(mockFeeHistoryCreate).toHaveBeenCalledWith({
      schoolId: 'SCH-1',
      studentId: 'STU-1',
      category: 'Grade 1',
      amount: 150,
      paid: false,
      totalPaid: 100,
      remainingBalance: 50,
    });
  });

  test('lowering the fee recalculates balance and marks the student paid', async () => {
    const original = { ...ORIGINAL, feeAmount: 150, feePaid: false, totalPaid: 100, remainingBalance: 50 };
    mockStudentFindOne = jest.fn(() => ({ lean: () => Promise.resolve(original) }));
    const updated = { ...original, feeAmount: 100 };
    mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue(updated);
    const recalculated = { ...updated, feePaid: true, remainingBalance: 0 };
    mockUpdateStudentBalance = jest.fn().mockResolvedValue(recalculated);

    const res = makeRes();
    await updateStudent(makeReq({ feeAmount: 100 }), res, jest.fn());

    expect(mockUpdateStudentBalance).toHaveBeenCalledWith('SCH-1', 'STU-1');
    expect(res.json).toHaveBeenCalledWith(recalculated);
    expect(mockFeeHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100, paid: true, remainingBalance: 0 })
    );
  });

  test('a name-only update does not recalculate balance or write fee history', async () => {
    mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({ ...ORIGINAL, name: 'Grace' });
    mockUpdateStudentBalance = jest.fn();

    const res = makeRes();
    await updateStudent(makeReq({ name: 'Grace' }), res, jest.fn());

    expect(mockUpdateStudentBalance).not.toHaveBeenCalled();
    expect(mockFeeHistoryCreate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });

  test('re-submitting the same fee does not recalculate or write history', async () => {
    mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue(ORIGINAL);
    mockUpdateStudentBalance = jest.fn();

    await updateStudent(makeReq({ feeAmount: 100 }), makeRes(), jest.fn());

    expect(mockUpdateStudentBalance).not.toHaveBeenCalled();
    expect(mockFeeHistoryCreate).not.toHaveBeenCalled();
  });

  test('class change without a fee override takes the new class fee and recalculates', async () => {
    mockFeeStructureFindOne = jest.fn().mockResolvedValue({ feeAmount: 200 });
    const updated = { ...ORIGINAL, class: 'Grade 2', feeAmount: 200 };
    mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue(updated);
    mockUpdateStudentBalance = jest.fn().mockResolvedValue({ ...updated, feePaid: false, remainingBalance: 100 });

    await updateStudent(makeReq({ class: 'Grade 2' }), makeRes(), jest.fn());

    expect(mockUpdateStudentBalance).toHaveBeenCalledWith('SCH-1', 'STU-1');
    expect(mockFeeHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Grade 2', amount: 200, remainingBalance: 100 })
    );
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['non-numeric', 'abc'],
  ])('rejects a %s feeAmount with 400 and does not touch the database', async (_label, value) => {
    mockStudentFindOneAndUpdate = jest.fn();
    mockUpdateStudentBalance = jest.fn();
    const res = makeRes();

    await updateStudent(makeReq({ feeAmount: value }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockUpdateStudentBalance).not.toHaveBeenCalled();
  });
});
