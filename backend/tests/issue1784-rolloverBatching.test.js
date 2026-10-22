'use strict';

/**
 * Tests for Issue #1784 — academic period rollover must write in batches rather
 * than with several awaited round trips per student, read students inside the
 * transaction, and not double-count when withTransaction retries the callback.
 */

const SCHOOL_ID = 'SCH-1';
const PERIOD_ID = 'period-1';
const PERIOD2_ID = 'period-2';

// Chainable query stub for `.find(...).session(s).lean()`.
function chain(value) {
  const q = { session: jest.fn(() => q), lean: () => Promise.resolve(value) };
  return q;
}

function query(value) {
  const q = {
    session: jest.fn(() => q),
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

let mockStartSession;
let mockAcademicPeriodFindOne;
let mockAcademicPeriodUpdateOne;
let mockStudentFind;
let mockStudentBulkWrite;
let mockStudentPeriodFeeFind;
let mockStudentPeriodFeeBulkWrite;
let mockStudentPeriodFeeFindOne;
let mockStudentPeriodFeeUpdateOne;
let mockStudentUpdateOne;
let mockFeeStructureFind;

jest.mock('mongoose', () => ({
  connection: {
    startSession: (...args) => mockStartSession(...args),
  },
}));
jest.mock('../src/models/academicPeriodModel', () => ({
  findOne: (...args) => mockAcademicPeriodFindOne(...args),
  updateOne: (...args) => mockAcademicPeriodUpdateOne(...args),
}));
jest.mock('../src/models/studentPeriodFeeModel', () => ({
  find: (...args) => mockStudentPeriodFeeFind(...args),
  bulkWrite: (...args) => mockStudentPeriodFeeBulkWrite(...args),
  findOne: (...args) => mockStudentPeriodFeeFindOne(...args),
  updateOne: (...args) => mockStudentPeriodFeeUpdateOne(...args),
}));
jest.mock('../src/models/studentModel', () => ({
  find: (...args) => mockStudentFind(...args),
  bulkWrite: (...args) => mockStudentBulkWrite(...args),
  updateOne: (...args) => mockStudentUpdateOne(...args),
}));
jest.mock('../src/models/feeStructureModel', () => ({
  find: (...args) => mockFeeStructureFind(...args),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { rolloverToNextPeriod } = require('../src/services/academicPeriodService');

const currentPeriod = { _id: PERIOD_ID, name: '2026/27 Term 1', isCurrent: true, isClosed: false };
const nextPeriod = { _id: PERIOD2_ID, name: '2026/27 Term 2', isCurrent: false, isClosed: false };

function makeStudents(count) {
  return Array.from({ length: count }, (_, i) => ({
    studentId: `stu-${i}`,
    class: 'JSS1',
    feeAmount: 100,
    remainingBalance: 0,
  }));
}

// withTransaction runs the callback `attempts` times, as a retry would.
function makeSession({ attempts = 1 } = {}) {
  return {
    withTransaction: async (fn) => {
      for (let i = 0; i < attempts; i++) await fn();
    },
    endSession: jest.fn(),
  };
}

function setup(students, { attempts = 1 } = {}) {
  mockStartSession = jest.fn().mockResolvedValue(makeSession({ attempts }));
  let findOneCalls = 0;
  mockAcademicPeriodFindOne = jest.fn(() => {
    findOneCalls++;
    return query(findOneCalls === 1 ? currentPeriod : nextPeriod);
  });
  mockAcademicPeriodUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  mockStudentFind = jest.fn(() => query(students));
  mockStudentBulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  mockStudentPeriodFeeFind = jest.fn(() => chain([]));
  mockStudentPeriodFeeBulkWrite = jest.fn().mockResolvedValue({ upsertedCount: 1 });
  mockStudentPeriodFeeFindOne = jest.fn(() => query(null));
  mockStudentPeriodFeeUpdateOne = jest.fn().mockResolvedValue({});
  mockStudentUpdateOne = jest.fn().mockResolvedValue({});
  mockFeeStructureFind = jest.fn(() => chain([{ className: 'JSS1', feeAmount: 100 }]));
}

const rollover = () => rolloverToNextPeriod({
  schoolId: SCHOOL_ID,
  nextPeriodId: PERIOD2_ID,
  performedBy: 'admin-1',
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Issue #1784 — batched rollover', () => {
  test('writes students in bulkWrite batches of at most 500', async () => {
    setup(makeStudents(1200));

    await rollover();

    const sizes = mockStudentPeriodFeeBulkWrite.mock.calls.map(([ops]) => ops.length);
    expect(sizes).toEqual([500, 500, 200]);
    const studentSizes = mockStudentBulkWrite.mock.calls.map(([ops]) => ops.length);
    expect(studentSizes).toEqual([500, 500, 200]);
  });

  test('a 10,000-student school uses a fixed number of round trips per batch, not per student', async () => {
    setup(makeStudents(10000));

    const result = await rollover();

    expect(result.studentsRolledOver).toBe(10000);
    expect(mockStudentPeriodFeeBulkWrite).toHaveBeenCalledTimes(20);
    expect(mockStudentBulkWrite).toHaveBeenCalledTimes(20);
    // No per-student writes or reads remain.
    expect(mockStudentPeriodFeeUpdateOne).not.toHaveBeenCalled();
    expect(mockStudentUpdateOne).not.toHaveBeenCalled();
    expect(mockStudentPeriodFeeFindOne).not.toHaveBeenCalled();
    expect(mockStudentPeriodFeeFind).toHaveBeenCalledTimes(1);
  });

  test('students and fee structures are read inside the transaction', async () => {
    setup(makeStudents(3));
    const session = makeSession();
    mockStartSession = jest.fn().mockResolvedValue(session);

    await rollover();

    expect(mockStudentFind.mock.results[0].value.session).toHaveBeenCalledWith(session);
    expect(mockStudentPeriodFeeFind.mock.results[0].value.session).toHaveBeenCalledWith(session);
    expect(mockFeeStructureFind.mock.results[0].value.session).toHaveBeenCalledWith(session);
  });

  test('a retried transaction does not double-count students or arrears', async () => {
    setup(makeStudents(7), { attempts: 2 });

    const result = await rollover();

    expect(result.studentsRolledOver).toBe(7);
    expect(result.totalArrears).toBe(0);
    const writtenStudents = mockStudentPeriodFeeBulkWrite.mock.calls
      .reduce((sum, [ops]) => sum + ops.length, 0);
    expect(writtenStudents).toBe(14);
  });

  test('closing assignments are fetched once and used for arrears', async () => {
    setup(makeStudents(2));
    mockStudentPeriodFeeFind = jest.fn(() => chain([
      { studentId: 'stu-0', feeAmount: 100, carriedArrears: 0, totalPaid: 40 },
    ]));

    const result = await rollover();

    expect(mockStudentPeriodFeeFind).toHaveBeenCalledWith({ schoolId: SCHOOL_ID, periodId: PERIOD_ID });
    expect(result.totalArrears).toBe(60);
    const stu0 = mockStudentPeriodFeeBulkWrite.mock.calls[0][0]
      .find((op) => op.updateOne.filter.studentId === 'stu-0');
    expect(stu0.updateOne.update.$set.carriedArrears).toBe(60);
  });
});
