'use strict';

/**
 * Tests for Issue #1785 — StudentPeriodFee.totalPaid must be kept in step with
 * payments, so a student who paid a period in full carries no arrears forward.
 */

const SCHOOL_ID = 'SCH-1';
const STUDENT_ID = 'STU-1';
const PERIOD_ID = 'period-1';
const PERIOD2_ID = 'period-2';
const PERIOD_START = new Date('2026-09-01T00:00:00Z');

// Chainable query stub: works with `await q`, `q.lean()` and `q.session()`.
function query(value) {
  const q = {
    session: () => q,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

let mockPaymentAggregate;
let mockStudentFindOne;
let mockStudentFind;
let mockStudentUpdateOne;
let mockStudentFindOneAndUpdate;
let mockAcademicPeriodFindOne;
let mockAcademicPeriodUpdateOne;
let mockStudentPeriodFeeFindOne;
let mockStudentPeriodFeeUpdateOne;
let mockStudentPeriodFeeFind;
let mockStudentPeriodFeeBulkWrite;
let mockStudentBulkWrite;
let mockFeeStructureFind;
let periodFeeStore;

jest.mock('../src/models/paymentModel', () => ({
  aggregate: (...args) => mockPaymentAggregate(...args),
}));
jest.mock('../src/models/studentModel', () => ({
  findOne: (...args) => mockStudentFindOne(...args),
  findOneAndUpdate: (...args) => mockStudentFindOneAndUpdate(...args),
  find: (...args) => mockStudentFind(...args),
  updateOne: (...args) => mockStudentUpdateOne(...args),
  bulkWrite: (...args) => mockStudentBulkWrite(...args),
}));
jest.mock('../src/models/academicPeriodModel', () => ({
  findOne: (...args) => mockAcademicPeriodFindOne(...args),
  updateOne: (...args) => mockAcademicPeriodUpdateOne(...args),
}));
jest.mock('../src/models/studentPeriodFeeModel', () => ({
  findOne: (...args) => mockStudentPeriodFeeFindOne(...args),
  updateOne: (...args) => mockStudentPeriodFeeUpdateOne(...args),
  find: (...args) => mockStudentPeriodFeeFind(...args),
  bulkWrite: (...args) => mockStudentPeriodFeeBulkWrite(...args),
}));
jest.mock('../src/models/feeStructureModel', () => ({
  find: (...args) => mockFeeStructureFind(...args),
}));
jest.mock('mongoose', () => ({
  connection: {
    startSession: jest.fn().mockResolvedValue({
      withTransaction: async (fn) => fn(),
      endSession: jest.fn(),
    }),
  },
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { updateStudentBalance } = require('../src/utils/studentBalanceUpdater');
const { rolloverToNextPeriod } = require('../src/services/academicPeriodService');

const currentPeriod = { _id: PERIOD_ID, name: '2026/27 Term 1', startsAt: PERIOD_START, isCurrent: true, isClosed: false };
const nextPeriod = { _id: PERIOD2_ID, name: '2026/27 Term 2', startsAt: new Date('2027-01-08T00:00:00Z'), isCurrent: false, isClosed: false };

const student = {
  schoolId: SCHOOL_ID,
  studentId: STUDENT_ID,
  class: 'JSS1',
  feeAmount: 100,
  fees: [],
  creditAdjustments: 0,
};

// Payments total `all` across the student's life and `inPeriod` since the period started.
function mockPaymentTotals({ all, inPeriod }) {
  mockPaymentAggregate = jest.fn((pipeline) => {
    const match = pipeline[0].$match;
    const total = match.createdAt ? inPeriod : all;
    return query(total === null ? [] : [{ total: { toString: () => String(total) } }]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  periodFeeStore = {
    _id: 'period-fee-1',
    schoolId: SCHOOL_ID,
    studentId: STUDENT_ID,
    periodId: PERIOD_ID,
    feeAmount: 100,
    carriedArrears: 0,
    creditAdjustments: 0,
    totalPaid: 0,
    remainingBalance: 100,
    feePaid: false,
  };

  mockStudentFindOne = jest.fn(() => query(student));
  mockStudentFindOneAndUpdate = jest.fn(() => query({ ...student }));
  mockStudentUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  mockAcademicPeriodUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  mockStudentPeriodFeeUpdateOne = jest.fn((filter, update) => {
    if (update && update.$set) Object.assign(periodFeeStore, update.$set);
    return Promise.resolve({ modifiedCount: 1 });
  });
  mockStudentPeriodFeeFindOne = jest.fn(() => query({ ...periodFeeStore }));
  mockAcademicPeriodFindOne = jest.fn((filter) => {
    if (filter.isCurrent === true) return query(currentPeriod);
    if (String(filter._id) === PERIOD2_ID) return query(nextPeriod);
    return query(null);
  });
  mockStudentFind = jest.fn(() => query([student]));
  mockFeeStructureFind = jest.fn(() => query([{ className: 'JSS1', feeAmount: 100 }]));
  mockStudentPeriodFeeFind = jest.fn(() => query([{ ...periodFeeStore }]));
  mockStudentPeriodFeeBulkWrite = jest.fn().mockResolvedValue({});
  mockStudentBulkWrite = jest.fn().mockResolvedValue({});
});

describe('Issue #1785 — period totalPaid sync', () => {
  test('a payment updates the current period record with the amount paid', async () => {
    mockPaymentTotals({ all: 60, inPeriod: 60 });

    await updateStudentBalance(SCHOOL_ID, STUDENT_ID);

    expect(mockStudentPeriodFeeUpdateOne).toHaveBeenCalledWith(
      { _id: 'period-fee-1' },
      { $set: { totalPaid: 60, remainingBalance: 40, feePaid: false } },
      { session: null }
    );
  });

  test('paying the full period fee marks the period record as paid', async () => {
    mockPaymentTotals({ all: 100, inPeriod: 100 });

    await updateStudentBalance(SCHOOL_ID, STUDENT_ID);

    expect(periodFeeStore).toMatchObject({ totalPaid: 100, remainingBalance: 0, feePaid: true });
  });

  test('period totals only count payments made on or after the period start', async () => {
    mockPaymentTotals({ all: 250, inPeriod: 100 });

    await updateStudentBalance(SCHOOL_ID, STUDENT_ID);

    const periodPipeline = mockPaymentAggregate.mock.calls
      .map(([pipeline]) => pipeline)
      .find((pipeline) => pipeline[0].$match.createdAt);
    expect(periodPipeline[0].$match.createdAt).toEqual({ $gte: PERIOD_START });
    expect(periodFeeStore.totalPaid).toBe(100);
  });

  test('no current period means nothing is written to the period record', async () => {
    mockPaymentTotals({ all: 50, inPeriod: 50 });
    mockAcademicPeriodFindOne = jest.fn(() => query(null));

    await updateStudentBalance(SCHOOL_ID, STUDENT_ID);

    expect(mockStudentPeriodFeeUpdateOne).not.toHaveBeenCalled();
  });

  test('rollover after a full payment carries zero arrears (issue scenario)', async () => {
    // P1: fee 100, paid 100 in full.
    mockPaymentTotals({ all: 100, inPeriod: 100 });
    await updateStudentBalance(SCHOOL_ID, STUDENT_ID);

    const result = await rolloverToNextPeriod({
      schoolId: SCHOOL_ID,
      nextPeriodId: PERIOD2_ID,
      performedBy: 'admin-1',
    });

    expect(result.totalArrears).toBe(0);
    const newFeeWrite = mockStudentPeriodFeeBulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(newFeeWrite.$set).toMatchObject({ periodName: nextPeriod.name, carriedArrears: 0, remainingBalance: 100, feePaid: false });
  });

  test('rollover after a partial payment carries only the unpaid balance', async () => {
    mockPaymentTotals({ all: 70, inPeriod: 70 });
    await updateStudentBalance(SCHOOL_ID, STUDENT_ID);

    const result = await rolloverToNextPeriod({
      schoolId: SCHOOL_ID,
      nextPeriodId: PERIOD2_ID,
      performedBy: 'admin-1',
    });

    expect(result.totalArrears).toBe(30);
  });
});
