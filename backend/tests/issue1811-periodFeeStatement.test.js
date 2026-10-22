'use strict';

/**
 * Tests for Issue #1811 — Per-period fee statements for parents.
 *
 * Contract under test (statementService.buildStatement):
 *  - Lists fee lines by category for the period (StudentPeriodFee)
 *  - Carries arrears in and reports them separately
 *  - Lists each payment with date, asset, amount, local value, tx hash and receipt id
 *  - Lists credit adjustments, refunds and dispute holds
 *  - Closing balance equals the canonical balance (dashboard figure)
 *  - Scoped to one school: never returns another school's rows
 */

// ── Model mocks ───────────────────────────────────────────────────────────────

const mockStudentFindOne = jest.fn();
const mockPeriodFeeFind = jest.fn();
const mockPaymentFind = jest.fn();
const mockRefundFind = jest.fn();
const mockDisputeFind = jest.fn();
const mockCanonicalBalance = jest.fn();

jest.mock('../src/models/studentModel', () => ({
  findOne: (...args) => mockStudentFindOne(...args),
}));
jest.mock('../src/models/studentPeriodFeeModel', () => ({
  find: (...args) => mockPeriodFeeFind(...args),
}));
jest.mock('../src/models/paymentModel', () => ({
  find: (...args) => mockPaymentFind(...args),
}));
jest.mock('../src/models/refundModel', () => ({
  find: (...args) => mockRefundFind(...args),
}));
jest.mock('../src/models/disputeModel', () => ({
  find: (...args) => mockDisputeFind(...args),
}));
jest.mock('../src/services/balanceService', () => ({
  getStudentBalance: (...args) => mockCanonicalBalance(...args),
}));

const statementService = require('../src/services/statementService');

const SCHOOL = 'school-a';
const STUDENT = 'student-1';
const PERIOD = 'period-2026-t1';

function chain(rows) {
  const q = {
    lean: jest.fn().mockResolvedValue(rows),
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();

  mockStudentFindOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      _id: STUDENT,
      schoolId: SCHOOL,
      name: 'Ada Eze',
      studentId: 'STU-001',
      arrearsBroughtForward: 5000,
    }),
  });

  mockPeriodFeeFind.mockReturnValue(
    chain([
      { category: 'tuition', amountDue: 80000, periodId: PERIOD, schoolId: SCHOOL },
      { category: 'uniform', amountDue: 15000, periodId: PERIOD, schoolId: SCHOOL },
      { category: 'exam', amountDue: 5000, periodId: PERIOD, schoolId: SCHOOL },
    ]),
  );

  mockPaymentFind.mockReturnValue(
    chain([
      {
        _id: 'pay-1',
        createdAt: new Date('2026-09-02T10:00:00Z'),
        assetCode: 'USDC',
        amount: 60000,
        localAmount: 60000,
        txHash: 'abc123',
        receiptId: 'rcpt-1',
        schoolId: SCHOOL,
      },
    ]),
  );

  mockRefundFind.mockReturnValue(chain([{ amount: 2000, schoolId: SCHOOL, status: 'completed' }]));
  mockDisputeFind.mockReturnValue(chain([{ holdAmount: 3000, schoolId: SCHOOL, status: 'open' }]));

  mockCanonicalBalance.mockResolvedValue({ balance: 39000 });
});

describe('statementService.buildStatement', () => {
  it('lists fee lines by category for the requested period', async () => {
    const statement = await statementService.buildStatement(SCHOOL, STUDENT, PERIOD);

    const categories = statement.feeLines.map((l) => l.category).sort();
    expect(categories).toEqual(['exam', 'tuition', 'uniform']);
    expect(statement.feeLines.find((l) => l.category === 'tuition').amountDue).toBe(80000);
  });

  it('reports arrears carried in separately from the period charges', async () => {
    const statement = await statementService.buildStatement(SCHOOL, STUDENT, PERIOD);

    expect(statement.arrearsBroughtForward).toBe(5000);
    expect(statement.periodCharges).toBe(100000);
  });

  it('includes each payment with date, asset, amount, local value, tx hash and receipt id', async () => {
    const statement = await statementService.buildStatement(SCHOOL, STUDENT, PERIOD);

    expect(statement.payments).toHaveLength(1);
    expect(statement.payments[0]).toEqual(
      expect.objectContaining({
        date: new Date('2026-09-02T10:00:00Z'),
        assetCode: 'USDC',
        amount: 60000,
        localAmount: 60000,
        txHash: 'abc123',
        receiptId: 'rcpt-1',
      }),
    );
  });

  it('includes refunds and dispute holds', async () => {
    const statement = await statementService.buildStatement(SCHOOL, STUDENT, PERIOD);

    expect(statement.refunds).toEqual([expect.objectContaining({ amount: 2000 })]);
    expect(statement.disputeHolds).toEqual([expect.objectContaining({ holdAmount: 3000 })]);
  });

  it('closing balance equals the canonical dashboard balance', async () => {
    const statement = await statementService.buildStatement(SCHOOL, STUDENT, PERIOD);

    expect(mockCanonicalBalance).toHaveBeenCalledWith(SCHOOL, STUDENT);
    expect(statement.closingBalance).toBe(39000);
  });

  it('only queries rows belonging to the requested school', async () => {
    await statementService.buildStatement(SCHOOL, STUDENT, PERIOD);

    expect(mockStudentFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: STUDENT, schoolId: SCHOOL }),
    );
    for (const mock of [mockPeriodFeeFind, mockPaymentFind, mockRefundFind, mockDisputeFind]) {
      expect(mock.mock.calls[0][0]).toEqual(expect.objectContaining({ schoolId: SCHOOL }));
    }
  });

  it('throws a not-found error when the student does not belong to the school', async () => {
    mockStudentFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    await expect(statementService.buildStatement(SCHOOL, 'other-school-student', PERIOD))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
