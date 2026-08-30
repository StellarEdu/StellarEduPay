'use strict';

/**
 * #1379: a student on a payment plan pays in installments, so every
 * installment is a partial payment against the total fee by design.
 * underpaidReconciliationService measured those payments against the total fee
 * and pulled them into the credit/refund workflow, which refunded money the
 * parent meant to pay and sent parents underpayment notices for installments
 * they made deliberately.
 *
 * Where an active plan exists the benchmark is the installment amount.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);

jest.mock('mongoose', () => {
  function isValid(id) {
    if (id == null) return false;
    return /^[0-9a-fA-F]{24}$/.test(String(id));
  }
  return { Types: { ObjectId: { isValid } } };
});

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
mockLogger.child = () => mockLogger;
jest.mock('../backend/src/utils/logger', () => mockLogger);

jest.mock('../backend/src/services/distributedLock', () => ({
  studentBalanceLockKey: (schoolId, studentId) => `lock:${schoolId}:${studentId}`,
  acquire: jest.fn().mockResolvedValue({ token: 'mock-token', fencingToken: 1 }),
  release: jest.fn().mockResolvedValue(true),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const mockPaymentFindById = jest.fn().mockResolvedValue(null);
const mockPaymentFindOne = jest.fn().mockResolvedValue(null);
const mockPaymentFind = jest.fn();

jest.mock('../backend/src/models/paymentModel', () => ({
  findById: (...args) => mockPaymentFindById(...args),
  findOne: (...args) => mockPaymentFindOne(...args),
  find: (...args) => mockPaymentFind(...args),
}));

const mockStudentFindOne = jest.fn();
const mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({});

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: (...args) => mockStudentFindOne(...args),
  findOneAndUpdate: (...args) => mockStudentFindOneAndUpdate(...args),
}));

const mockPlanFindOne = jest.fn().mockResolvedValue(null);

jest.mock('../backend/src/models/paymentPlanModel', () => ({
  findOne: (...args) => mockPlanFindOne(...args),
}));

const {
  evaluateUnderpayment,
  expectedInstallmentAmount,
  getPendingUnderpaidPayments,
  initiateRefund,
  applyPartialCredit,
} = require('../backend/src/services/underpaidReconciliationService');

// === Fixtures

const SCHOOL_ID = 'SCH-PLAN-TEST';
const PLAN_STUDENT = 'STU-PLAN';
const FULL_FEE_STUDENT = 'STU-FULL';
const TOTAL_FEE = 1200;
const INSTALLMENT = 300;

// Alice is on a four-installment plan: each installment is a quarter of the
// total fee, so measured against TOTAL_FEE every one of them looks underpaid.
function makePlan(overrides = {}) {
  return {
    schoolId: SCHOOL_ID,
    studentId: PLAN_STUDENT,
    totalAmount: TOTAL_FEE,
    status: 'active',
    installments: [
      { amount: INSTALLMENT, paid: true, paidAmount: INSTALLMENT },
      { amount: INSTALLMENT, paid: false, paidAmount: 0 },
      { amount: INSTALLMENT, paid: false, paidAmount: 0 },
      { amount: INSTALLMENT, paid: false, paidAmount: 0 },
    ],
    ...overrides,
  };
}

function makePayment(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    txHash: 'a'.repeat(64),
    schoolId: SCHOOL_ID,
    studentId: PLAN_STUDENT,
    amount: INSTALLMENT,
    feeAmount: TOTAL_FEE,
    feeValidationStatus: 'partial',
    underpaidReconciliation: { status: 'pending' },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFindChain(payments) {
  mockPaymentFind.mockReturnValue({
    sort: () => ({
      skip: () => ({
        limit: () => Promise.resolve(payments),
      }),
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlanFindOne.mockResolvedValue(null);
  mockPaymentFindById.mockResolvedValue(null);
  mockPaymentFindOne.mockResolvedValue(null);
  mockStudentFindOneAndUpdate.mockResolvedValue({});
});

// === Tests

describe('expectedInstallmentAmount', () => {
  test('uses the next unpaid installment', () => {
    expect(expectedInstallmentAmount(makePlan())).toBe(INSTALLMENT);
  });

  test('uses the final installment once every one is settled', () => {
    const plan = makePlan({
      installments: [
        { amount: 500, paid: true, paidAmount: 500 },
        { amount: 250, paid: true, paidAmount: 250 },
      ],
    });
    expect(expectedInstallmentAmount(plan)).toBe(250);
  });

  test('returns null for a plan with no installments', () => {
    expect(expectedInstallmentAmount(makePlan({ installments: [] }))).toBeNull();
  });
});

describe('evaluateUnderpayment', () => {
  test('an installment-sized payment on an active plan is not underpaid', async () => {
    mockPlanFindOne.mockResolvedValue(makePlan());

    const result = await evaluateUnderpayment(makePayment({ amount: INSTALLMENT }));

    expect(result.underpaid).toBe(false);
    expect(result.basis).toBe('installment');
    expect(result.expectedAmount).toBe(INSTALLMENT);
  });

  test('looks the plan up scoped to the school and student', async () => {
    mockPlanFindOne.mockResolvedValue(makePlan());

    await evaluateUnderpayment(makePayment());

    expect(mockPlanFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: SCHOOL_ID,
        studentId: PLAN_STUDENT,
        status: 'active',
        deletedAt: null,
      }),
    );
  });

  test('a payment above the installment amount is not underpaid', async () => {
    mockPlanFindOne.mockResolvedValue(makePlan());

    const result = await evaluateUnderpayment(makePayment({ amount: INSTALLMENT + 50 }));

    expect(result.underpaid).toBe(false);
  });

  test('a payment below the installment amount is still underpaid', async () => {
    mockPlanFindOne.mockResolvedValue(makePlan());

    const result = await evaluateUnderpayment(makePayment({ amount: INSTALLMENT - 1 }));

    expect(result.underpaid).toBe(true);
    expect(result.basis).toBe('installment');
  });

  test('a student with no plan is still measured against the fee', async () => {
    mockPlanFindOne.mockResolvedValue(null);

    const result = await evaluateUnderpayment(
      makePayment({ studentId: FULL_FEE_STUDENT, amount: INSTALLMENT }),
    );

    expect(result.underpaid).toBe(true);
    expect(result.basis).toBe('fee');
  });

  test('a cancelled or completed plan does not exempt a payment', async () => {
    // The query filters on status: 'active', so a settled plan returns null.
    mockPlanFindOne.mockResolvedValue(null);

    const result = await evaluateUnderpayment(makePayment());

    expect(result.underpaid).toBe(true);
    expect(result.basis).toBe('fee');
  });
});

describe('getPendingUnderpaidPayments', () => {
  test('omits installment payments and keeps genuinely short ones', async () => {
    const installment = makePayment({ amount: INSTALLMENT });
    const short = makePayment({ amount: 10, txHash: 'b'.repeat(64) });
    mockFindChain([installment, short]);
    mockPlanFindOne.mockResolvedValue(makePlan());

    const pending = await getPendingUnderpaidPayments(SCHOOL_ID);

    expect(pending).toEqual([short]);
  });

  test('leaves the listing untouched for students with no plan', async () => {
    const payments = [
      makePayment({ studentId: FULL_FEE_STUDENT, amount: INSTALLMENT }),
      makePayment({ studentId: FULL_FEE_STUDENT, amount: 10, txHash: 'c'.repeat(64) }),
    ];
    mockFindChain(payments);
    mockPlanFindOne.mockResolvedValue(null);

    expect(await getPendingUnderpaidPayments(SCHOOL_ID)).toEqual(payments);
  });
});

describe('the underpaid workflow refuses to act on an installment', () => {
  test('initiateRefund throws rather than refunding a scheduled installment', async () => {
    const payment = makePayment({ amount: INSTALLMENT });
    mockPaymentFindOne.mockResolvedValue(payment);
    mockPlanFindOne.mockResolvedValue(makePlan());

    await expect(
      initiateRefund(payment.txHash, 'admin', SCHOOL_ID),
    ).rejects.toThrow(/active payment plan/);

    expect(payment.save).not.toHaveBeenCalled();
  });

  test('applyPartialCredit throws rather than crediting a scheduled installment', async () => {
    const payment = makePayment({ amount: INSTALLMENT });
    mockPaymentFindOne.mockResolvedValue(payment);
    mockPlanFindOne.mockResolvedValue(makePlan());

    await expect(
      applyPartialCredit(payment.txHash, 50, 'admin', SCHOOL_ID),
    ).rejects.toThrow(/active payment plan/);

    expect(payment.save).not.toHaveBeenCalled();
    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('initiateRefund still works for a genuinely short payment', async () => {
    const payment = makePayment({ amount: 10 });
    mockPaymentFindOne.mockResolvedValue(payment);
    mockPlanFindOne.mockResolvedValue(makePlan());

    await initiateRefund(payment.txHash, 'admin', SCHOOL_ID);

    expect(payment.underpaidReconciliation.status).toBe('refund_initiated');
    expect(payment.save).toHaveBeenCalled();
  });
});
