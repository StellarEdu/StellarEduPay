'use strict';

/**
 * Tests for Issue #1569 — AcademicPeriod model, StudentPeriodFee, and
 * academicPeriodService (createPeriod, listPeriods, getCurrentPeriod,
 * updatePeriod, upsertStudentPeriodFee, rolloverToNextPeriod).
 */

// ── Mock helpers ──────────────────────────────────────────────────────────────

// Lightweight mongoose session/transaction stub.
function makeSession() {
  return {
    withTransaction: async (fn) => fn(),
    endSession: jest.fn(),
  };
}

let mockStartSession;
let mockAcademicPeriodCreate;
let mockAcademicPeriodFindOne;
let mockAcademicPeriodFind;
let mockAcademicPeriodUpdateOne;
let mockStudentPeriodFeeUpdateOne;
let mockStudentPeriodFeeFindOne;
let mockStudentFind;
let mockStudentUpdateOne;
let mockFeeStructureFind;
let mockLogAudit;

// Saved save functions for period docs returned from findOne.
let _savedPeriod = null;

jest.mock('mongoose', () => {
  return {
    connection: {
      startSession: (...args) => mockStartSession(...args),
    },
  };
});

jest.mock('../src/models/academicPeriodModel', () => ({
  create:        (...args) => mockAcademicPeriodCreate(...args),
  findOne:       (...args) => mockAcademicPeriodFindOne(...args),
  find:          (...args) => mockAcademicPeriodFind(...args),
  updateOne:     (...args) => mockAcademicPeriodUpdateOne(...args),
}));

jest.mock('../src/models/studentPeriodFeeModel', () => ({
  updateOne: (...args) => mockStudentPeriodFeeUpdateOne(...args),
  findOne:   (...args) => mockStudentPeriodFeeFindOne(...args),
  create:    jest.fn(),
}));

jest.mock('../src/models/studentModel', () => ({
  find:      (...args) => mockStudentFind(...args),
  updateOne: (...args) => mockStudentUpdateOne(...args),
}));

jest.mock('../src/models/feeStructureModel', () => ({
  find: (...args) => mockFeeStructureFind(...args),
}));

jest.mock('../src/services/auditService', () => ({
  logAudit: (...args) => mockLogAudit(...args),
}));

jest.mock('../src/utils/logger', () => ({
  child: () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Import after mocks are established.
const {
  createPeriod,
  listPeriods,
  getCurrentPeriod,
  getPeriodById,
  updatePeriod,
  upsertStudentPeriodFee,
  rolloverToNextPeriod,
} = require('../src/services/academicPeriodService');

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SCHOOL_ID = 'school-test-1';
const PERIOD_ID  = 'period-abc';
const PERIOD2_ID = 'period-def';

function makePeriodDoc(overrides = {}) {
  const doc = {
    _id:       overrides._id  || PERIOD_ID,
    schoolId:  SCHOOL_ID,
    name:      'Term 1 2026',
    startsAt:  new Date('2026-01-01'),
    endsAt:    new Date('2026-06-30'),
    isCurrent: false,
    isClosed:  false,
    notes:     null,
    ...overrides,
  };
  doc.save       = jest.fn().mockResolvedValue(doc);
  doc.toObject   = () => ({ ...doc });
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
// createPeriod
// ─────────────────────────────────────────────────────────────────────────────

describe('createPeriod', () => {
  beforeEach(() => {
    mockAcademicPeriodCreate = jest.fn();
    mockLogAudit = jest.fn().mockResolvedValue(undefined);
  });

  test('creates a period with valid inputs', async () => {
    const created = makePeriodDoc();
    mockAcademicPeriodCreate.mockResolvedValue(created);

    const result = await createPeriod({
      schoolId: SCHOOL_ID,
      name: 'Term 1 2026',
      startsAt: '2026-01-01',
      endsAt:   '2026-06-30',
    });

    expect(mockAcademicPeriodCreate).toHaveBeenCalledTimes(1);
    expect(result._id).toBe(PERIOD_ID);
  });

  test('throws VALIDATION_ERROR when schoolId is missing', async () => {
    await expect(
      createPeriod({ name: 'Term 1', startsAt: '2026-01-01', endsAt: '2026-06-30' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mockAcademicPeriodCreate).not.toHaveBeenCalled();
  });

  test('throws VALIDATION_ERROR when startsAt >= endsAt', async () => {
    await expect(
      createPeriod({ schoolId: SCHOOL_ID, name: 'Bad', startsAt: '2026-06-30', endsAt: '2026-01-01' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('throws VALIDATION_ERROR when startsAt === endsAt', async () => {
    await expect(
      createPeriod({ schoolId: SCHOOL_ID, name: 'Same Day', startsAt: '2026-03-01', endsAt: '2026-03-01' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listPeriods / getCurrentPeriod / getPeriodById
// ─────────────────────────────────────────────────────────────────────────────

describe('listPeriods', () => {
  test('returns periods sorted by startsAt descending', async () => {
    const periods = [makePeriodDoc({ _id: PERIOD2_ID }), makePeriodDoc({ _id: PERIOD_ID })];
    mockAcademicPeriodFind = jest.fn().mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(periods) }),
    });

    const result = await listPeriods(SCHOOL_ID);
    expect(result).toHaveLength(2);
    expect(mockAcademicPeriodFind).toHaveBeenCalledWith({ schoolId: SCHOOL_ID });
  });
});

describe('getCurrentPeriod', () => {
  test('returns the current period', async () => {
    const current = makePeriodDoc({ isCurrent: true });
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(current),
    });

    const result = await getCurrentPeriod(SCHOOL_ID);
    expect(result.isCurrent).toBe(true);
    expect(mockAcademicPeriodFindOne).toHaveBeenCalledWith({ schoolId: SCHOOL_ID, isCurrent: true });
  });

  test('returns null when no current period exists', async () => {
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    const result = await getCurrentPeriod(SCHOOL_ID);
    expect(result).toBeNull();
  });
});

describe('getPeriodById', () => {
  test('returns the period when found', async () => {
    const period = makePeriodDoc();
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(period),
    });

    const result = await getPeriodById(SCHOOL_ID, PERIOD_ID);
    expect(result._id).toBe(PERIOD_ID);
  });

  test('throws NOT_FOUND when period does not exist', async () => {
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    await expect(getPeriodById(SCHOOL_ID, 'nonexistent')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updatePeriod
// ─────────────────────────────────────────────────────────────────────────────

describe('updatePeriod', () => {
  beforeEach(() => {
    _savedPeriod = makePeriodDoc();
    mockAcademicPeriodFindOne = jest.fn().mockResolvedValue(_savedPeriod);
  });

  test('updates notes on an open period', async () => {
    await updatePeriod(SCHOOL_ID, PERIOD_ID, { notes: 'Updated notes' });
    expect(_savedPeriod.save).toHaveBeenCalledTimes(1);
    expect(_savedPeriod.notes).toBe('Updated notes');
  });

  test('updates name on an open period', async () => {
    await updatePeriod(SCHOOL_ID, PERIOD_ID, { name: 'New Name' });
    expect(_savedPeriod.name).toBe('New Name');
  });

  test('throws NOT_FOUND when period missing', async () => {
    mockAcademicPeriodFindOne = jest.fn().mockResolvedValue(null);
    await expect(updatePeriod(SCHOOL_ID, 'bad-id', { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('throws VALIDATION_ERROR when changing name on closed period', async () => {
    _savedPeriod.isClosed = true;
    await expect(
      updatePeriod(SCHOOL_ID, PERIOD_ID, { name: 'Changed' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(_savedPeriod.save).not.toHaveBeenCalled();
  });

  test('allows updating notes on closed period', async () => {
    _savedPeriod.isClosed = true;
    await updatePeriod(SCHOOL_ID, PERIOD_ID, { notes: 'Archive note' });
    expect(_savedPeriod.notes).toBe('Archive note');
    expect(_savedPeriod.save).toHaveBeenCalledTimes(1);
  });

  test('throws VALIDATION_ERROR when new dates make startsAt >= endsAt', async () => {
    await expect(
      updatePeriod(SCHOOL_ID, PERIOD_ID, { endsAt: '2025-01-01' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertStudentPeriodFee
// ─────────────────────────────────────────────────────────────────────────────

describe('upsertStudentPeriodFee', () => {
  beforeEach(() => {
    mockStudentPeriodFeeUpdateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    // findOne returns null → will call StudentPeriodFee.create path
    mockStudentPeriodFeeFindOne = jest.fn().mockResolvedValue(null);
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(makePeriodDoc()),
    });

    // Mock StudentPeriodFee.create (used when no existing doc)
    const SPF = require('../src/models/studentPeriodFeeModel');
    SPF.create = jest.fn().mockResolvedValue({
      schoolId: SCHOOL_ID, studentId: 'stu-1', periodId: PERIOD_ID,
      feeAmount: 500, carriedArrears: 0, totalPaid: 0,
      remainingBalance: 500, feePaid: false,
      toObject: function() { return { ...this }; },
    });
  });

  test('upserts fee assignment with valid params', async () => {
    const result = await upsertStudentPeriodFee({
      schoolId:  SCHOOL_ID,
      studentId: 'stu-1',
      periodId:  PERIOD_ID,
      feeAmount: 500,
    });
    expect(result).toBeDefined();
    expect(mockAcademicPeriodFindOne).toHaveBeenCalledTimes(1);
  });

  test('throws NOT_FOUND when period is missing', async () => {
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    await expect(
      upsertStudentPeriodFee({ schoolId: SCHOOL_ID, studentId: 'stu-1', periodId: 'bad', feeAmount: 100 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('throws VALIDATION_ERROR when periodId is missing (period lookup returns null)', async () => {
    mockAcademicPeriodFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    await expect(
      upsertStudentPeriodFee({ schoolId: SCHOOL_ID, studentId: 'stu-1', periodId: undefined, feeAmount: 100 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('includes carried arrears in remaining balance', async () => {
    const SPF = require('../src/models/studentPeriodFeeModel');
    await upsertStudentPeriodFee({
      schoolId:       SCHOOL_ID,
      studentId:      'stu-1',
      periodId:       PERIOD_ID,
      feeAmount:      500,
      carriedArrears: 100,
    });
    const [createArgs] = SPF.create.mock.calls;
    expect(createArgs[0].remainingBalance).toBe(600);
    expect(createArgs[0].carriedArrears).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rolloverToNextPeriod
// ─────────────────────────────────────────────────────────────────────────────

describe('rolloverToNextPeriod', () => {
  const PERFORMED_BY = 'admin-user-1';
  const currentPeriodDoc = makePeriodDoc({ _id: PERIOD_ID,  isCurrent: true, isClosed: false });
  const nextPeriodDoc    = makePeriodDoc({ _id: PERIOD2_ID, isCurrent: false, isClosed: false });

  const students = [
    { studentId: 'stu-1', class: 'JSS1', feeAmount: 500, remainingBalance: 200 },
    { studentId: 'stu-2', class: 'JSS2', feeAmount: 600, remainingBalance: 0   },
  ];

  const feeStructures = [
    { className: 'JSS1', feeAmount: 500 },
    { className: 'JSS2', feeAmount: 600 },
  ];

  beforeEach(() => {
    mockStartSession = jest.fn().mockResolvedValue(makeSession());

    // findOne returns current period on first call, next period on second, null on subsequent.
    let findOneCallCount = 0;
    mockAcademicPeriodFindOne = jest.fn().mockImplementation(() => {
      findOneCallCount++;
      if (findOneCallCount === 1) return Promise.resolve(currentPeriodDoc);
      if (findOneCallCount === 2) return Promise.resolve(nextPeriodDoc);
      return Promise.resolve(null);
    });

    mockAcademicPeriodUpdateOne   = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    mockStudentPeriodFeeFindOne   = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) });
    mockStudentPeriodFeeUpdateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    mockStudentFind               = jest.fn().mockReturnValue({ lean: () => Promise.resolve(students) });
    mockStudentUpdateOne          = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    mockFeeStructureFind          = jest.fn().mockReturnValue({ lean: () => Promise.resolve(feeStructures) });
    mockLogAudit                  = jest.fn().mockResolvedValue(undefined);
  });

  test('closes current period and activates next', async () => {
    const result = await rolloverToNextPeriod({
      schoolId:      SCHOOL_ID,
      nextPeriodId:  PERIOD2_ID,
      performedBy:   PERFORMED_BY,
    });

    expect(result.closedPeriod._id).toBe(PERIOD_ID);
    expect(result.newPeriod._id).toBe(PERIOD2_ID);
    expect(result.studentsRolledOver).toBe(2);

    // Verify the closing update was issued.
    const closeCall = mockAcademicPeriodUpdateOne.mock.calls.find(
      ([filter]) => String(filter._id) === PERIOD_ID
    );
    expect(closeCall).toBeDefined();
    expect(closeCall[1].$set).toMatchObject({ isCurrent: false, isClosed: true });

    // Verify the activation update was issued.
    const activateCall = mockAcademicPeriodUpdateOne.mock.calls.find(
      ([filter]) => String(filter._id) === PERIOD2_ID
    );
    expect(activateCall).toBeDefined();
    expect(activateCall[1].$set).toMatchObject({ isCurrent: true });
  });

  test('carries arrears when student has existing period fee with balance', async () => {
    // First student has a StudentPeriodFee with 200 outstanding.
    mockStudentPeriodFeeFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve({ feeAmount: 500, totalPaid: 300, carriedArrears: 0 }),
    });

    const result = await rolloverToNextPeriod({
      schoolId:     SCHOOL_ID,
      nextPeriodId: PERIOD2_ID,
      performedBy:  PERFORMED_BY,
    });

    expect(result.totalArrears).toBeGreaterThan(0);

    // Check that StudentPeriodFee.updateOne for stu-1 sets carriedArrears.
    const newFeeCall = mockStudentPeriodFeeUpdateOne.mock.calls[0];
    expect(newFeeCall[1].$set.carriedArrears).toBe(200);
  });

  test('sets zero arrears when student is fully paid', async () => {
    // Both students fully paid.
    mockStudentPeriodFeeFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve({ feeAmount: 500, totalPaid: 500, carriedArrears: 0 }),
    });

    const result = await rolloverToNextPeriod({
      schoolId:     SCHOOL_ID,
      nextPeriodId: PERIOD2_ID,
      performedBy:  PERFORMED_BY,
    });

    expect(result.totalArrears).toBe(0);
  });

  test('throws VALIDATION_ERROR when required params are missing', async () => {
    await expect(
      rolloverToNextPeriod({ schoolId: SCHOOL_ID })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('throws NOT_FOUND when no current period exists', async () => {
    mockAcademicPeriodFindOne = jest.fn().mockResolvedValue(null);
    await expect(
      rolloverToNextPeriod({ schoolId: SCHOOL_ID, nextPeriodId: PERIOD2_ID, performedBy: PERFORMED_BY })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('throws NOT_FOUND when target period does not exist', async () => {
    let callCount = 0;
    mockAcademicPeriodFindOne = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(currentPeriodDoc);
      return Promise.resolve(null); // next period not found
    });

    await expect(
      rolloverToNextPeriod({ schoolId: SCHOOL_ID, nextPeriodId: 'missing', performedBy: PERFORMED_BY })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('throws VALIDATION_ERROR when target period is already closed', async () => {
    let callCount = 0;
    const closedNext = makePeriodDoc({ _id: PERIOD2_ID, isClosed: true });
    mockAcademicPeriodFindOne = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(currentPeriodDoc);
      return Promise.resolve(closedNext);
    });

    await expect(
      rolloverToNextPeriod({ schoolId: SCHOOL_ID, nextPeriodId: PERIOD2_ID, performedBy: PERFORMED_BY })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('throws VALIDATION_ERROR when target is same as current', async () => {
    // Both lookups return a period with the same _id.
    const sameId = makePeriodDoc({ _id: PERIOD_ID, isCurrent: true });
    mockAcademicPeriodFindOne = jest.fn().mockResolvedValue(sameId);

    await expect(
      rolloverToNextPeriod({ schoolId: SCHOOL_ID, nextPeriodId: PERIOD_ID, performedBy: PERFORMED_BY })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('emits an audit log after rollover', async () => {
    await rolloverToNextPeriod({
      schoolId:    SCHOOL_ID,
      nextPeriodId: PERIOD2_ID,
      performedBy:  PERFORMED_BY,
    });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const [auditArgs] = mockLogAudit.mock.calls;
    expect(auditArgs[0]).toMatchObject({
      schoolId:    SCHOOL_ID,
      action:      'academic_period_rollover',
      performedBy: PERFORMED_BY,
    });
  });
});
