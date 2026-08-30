'use strict';

/**
 * Tests for underpaidReconciliationService (Issue #1039 / CastError fix).
 *
 * Focus: all three exported mutating functions must reach the txHash-based
 * lookup without throwing when the caller passes a 64-character Stellar
 * transaction hash instead of a MongoDB ObjectId.
 *
 * Before the fix, passing a txHash to Payment.findById() threw a Mongoose
 * CastError synchronously, which bypassed the txHash fallback entirely.
 * After the fix, mongoose.Types.ObjectId.isValid() gates the findById call,
 * so non-ObjectId identifiers fall straight through to findOne({ txHash }).
 */

// ── mongoose: mock isValid so the service doesn't need a real DB connection ───
//
// The service only uses mongoose.Types.ObjectId.isValid(id) to decide whether
// to attempt findById. We expose a real implementation so the routing logic
// (ObjectId string → findById, non-ObjectId string → findOne) is exercised
// correctly without requiring mongoose to be installed in the test environment.
jest.mock('mongoose', () => {
  // Replicate the real ObjectId.isValid() rule: 12-byte buffer or
  // 24-character hex string.  Everything else (including a 64-char txHash)
  // returns false.
  function isValid(id) {
    if (id == null) return false;
    const s = String(id);
    return /^[0-9a-fA-F]{24}$/.test(s) || (Buffer.isBuffer(id) && id.length === 12);
  }
  return { Types: { ObjectId: { isValid } } };
});

// ── Suppress logger noise ─────────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── Distributed lock: always succeeds, no-op release ─────────────────────────
jest.mock('../src/services/distributedLock', () => ({
  studentBalanceLockKey: (schoolId, studentId) => `lock:${schoolId}:${studentId}`,
  acquire: jest.fn().mockResolvedValue({ token: 'mock-token', fencingToken: 1 }),
  release: jest.fn().mockResolvedValue(true),
}));

// ── Payment model mock ────────────────────────────────────────────────────────
const mockFindById  = jest.fn();
const mockFindOne   = jest.fn();
const mockSave      = jest.fn().mockResolvedValue();

jest.mock('../src/models/paymentModel', () => ({
  findById:  (...args) => mockFindById(...args),
  findOne:   (...args) => mockFindOne(...args),
}));

// ── PaymentPlan model mock ───────────────────────────────────────────────────
// No active plan by default, so evaluateUnderpayment (#1379) falls back to the
// fee-based classification these tests were written against.
const mockPlanFindOne = jest.fn().mockResolvedValue(null);

jest.mock('../src/models/paymentPlanModel', () => ({
  findOne: (...args) => mockPlanFindOne(...args),
}));

// ── Student model mock ────────────────────────────────────────────────────────
const mockStudentFindOne          = jest.fn();
const mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({});

jest.mock('../src/models/studentModel', () => ({
  findOne:          (...args) => mockStudentFindOne(...args),
  findOneAndUpdate: (...args) => mockStudentFindOneAndUpdate(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A valid 64-character hex Stellar transaction hash. */
const STELLAR_TX_HASH = 'a'.repeat(64);

/** A valid MongoDB ObjectId string. */
const MONGO_ID = '507f1f77bcf86cd799439011';

const SCHOOL_ID  = 'school-test';
const STUDENT_ID = 'STU001';

/**
 * Build a minimal payment document that satisfies each function's validation.
 */
function makePayment(overrides = {}) {
  const base = {
    _id:                  MONGO_ID,
    txHash:               STELLAR_TX_HASH,
    schoolId:             SCHOOL_ID,
    studentId:            STUDENT_ID,
    amount:               100,
    feeAmount:            200,
    feeValidationStatus:  'underpaid',
    underpaidReconciliation: {
      status: 'pending',
    },
    save: mockSave,
  };
  return Object.assign({}, base, overrides);
}

/**
 * Build a minimal student document for the balance lock path in applyPartialCredit.
 */
function makeStudent(overrides = {}) {
  return Object.assign(
    { studentId: STUDENT_ID, schoolId: SCHOOL_ID, feeAmount: 200, totalPaid: 0 },
    overrides,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const {
  applyPartialCredit,
  initiateRefund,
  completeRefund,
} = require('../src/services/underpaidReconciliationService');

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockResolvedValue();
  mockStudentFindOneAndUpdate.mockResolvedValue({});
  mockPlanFindOne.mockResolvedValue(null);
});

// ── applyPartialCredit ────────────────────────────────────────────────────────

describe('applyPartialCredit', () => {
  it('does NOT call findById when passed a txHash, calls findOne({ txHash }) instead', async () => {
    const payment = makePayment();
    mockFindOne.mockResolvedValue(payment);
    mockStudentFindOne.mockResolvedValue(makeStudent());

    await applyPartialCredit(STELLAR_TX_HASH, 50, 'admin', SCHOOL_ID);

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: STELLAR_TX_HASH, schoolId: SCHOOL_ID }),
    );
  });

  it('calls findById when passed a valid ObjectId', async () => {
    const payment = makePayment({ txHash: 'abc' });
    mockFindById.mockResolvedValue(payment);
    mockStudentFindOne.mockResolvedValue(makeStudent());

    await applyPartialCredit(MONGO_ID, 50, 'admin', SCHOOL_ID);

    expect(mockFindById).toHaveBeenCalledWith(MONGO_ID);
    // findOne should NOT be called when findById succeeds
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('falls through to findOne({ txHash }) when findById returns null for a valid ObjectId', async () => {
    const payment = makePayment();
    mockFindById.mockResolvedValue(null);
    mockFindOne.mockResolvedValue(payment);
    mockStudentFindOne.mockResolvedValue(makeStudent());

    await applyPartialCredit(MONGO_ID, 50, 'admin', SCHOOL_ID);

    expect(mockFindById).toHaveBeenCalledWith(MONGO_ID);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: MONGO_ID, schoolId: SCHOOL_ID }),
    );
  });

  it('throws Payment not found when neither lookup matches', async () => {
    mockFindById.mockResolvedValue(null);
    mockFindOne.mockResolvedValue(null);

    await expect(
      applyPartialCredit(STELLAR_TX_HASH, 50, 'admin', SCHOOL_ID),
    ).rejects.toThrow(`Payment not found: ${STELLAR_TX_HASH}`);
  });

  it('throws when creditAmount is not positive', async () => {
    await expect(
      applyPartialCredit(STELLAR_TX_HASH, 0, 'admin', SCHOOL_ID),
    ).rejects.toThrow('creditAmount must be a positive number');

    // findById / findOne should never be reached
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

// ── initiateRefund ────────────────────────────────────────────────────────────

describe('initiateRefund', () => {
  it('does NOT call findById when passed a txHash, calls findOne({ txHash }) instead', async () => {
    const payment = makePayment();
    mockFindOne.mockResolvedValue(payment);

    await initiateRefund(STELLAR_TX_HASH, 'admin', SCHOOL_ID);

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: STELLAR_TX_HASH, schoolId: SCHOOL_ID }),
    );
  });

  it('calls findById when passed a valid ObjectId', async () => {
    const payment = makePayment();
    mockFindById.mockResolvedValue(payment);

    await initiateRefund(MONGO_ID, 'admin', SCHOOL_ID);

    expect(mockFindById).toHaveBeenCalledWith(MONGO_ID);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('falls through to findOne({ txHash }) when findById returns null for a valid ObjectId', async () => {
    const payment = makePayment();
    mockFindById.mockResolvedValue(null);
    mockFindOne.mockResolvedValue(payment);

    await initiateRefund(MONGO_ID, 'admin', SCHOOL_ID);

    expect(mockFindById).toHaveBeenCalledWith(MONGO_ID);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: MONGO_ID, schoolId: SCHOOL_ID }),
    );
  });

  it('throws Payment not found when neither lookup matches', async () => {
    mockFindById.mockResolvedValue(null);
    mockFindOne.mockResolvedValue(null);

    await expect(
      initiateRefund(STELLAR_TX_HASH, 'admin', SCHOOL_ID),
    ).rejects.toThrow(`Payment not found: ${STELLAR_TX_HASH}`);
  });
});

// ── completeRefund ────────────────────────────────────────────────────────────

describe('completeRefund', () => {
  const REFUND_TX_HASH = 'b'.repeat(64);
  const OTHER_SCHOOL_ID = 'school-other';

  it('does NOT call findById when passed a txHash, calls findOne({ txHash, schoolId }) instead', async () => {
    const payment = makePayment();
    mockFindOne.mockResolvedValue(payment);

    await completeRefund(STELLAR_TX_HASH, REFUND_TX_HASH, SCHOOL_ID);

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledWith({ txHash: STELLAR_TX_HASH, schoolId: SCHOOL_ID });
  });

  it('scopes the ObjectId lookup to schoolId via findOne({ _id, schoolId })', async () => {
    const payment = makePayment();
    mockFindOne.mockResolvedValue(payment);

    await completeRefund(MONGO_ID, REFUND_TX_HASH, SCHOOL_ID);

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledWith({ _id: MONGO_ID, schoolId: SCHOOL_ID });
  });

  it('falls through to findOne({ txHash, schoolId }) when ObjectId lookup returns null', async () => {
    const payment = makePayment();
    // First call (ObjectId branch) returns null, second (txHash branch) succeeds.
    mockFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(payment);

    await completeRefund(MONGO_ID, REFUND_TX_HASH, SCHOOL_ID);

    expect(mockFindOne).toHaveBeenNthCalledWith(1, { _id: MONGO_ID, schoolId: SCHOOL_ID });
    expect(mockFindOne).toHaveBeenNthCalledWith(2, { txHash: MONGO_ID, schoolId: SCHOOL_ID });
  });

  it('throws Payment not found when neither lookup matches', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      completeRefund(STELLAR_TX_HASH, REFUND_TX_HASH, SCHOOL_ID),
    ).rejects.toThrow(`Payment not found: ${STELLAR_TX_HASH}`);
  });

  it('throws when refundTxHash is missing', async () => {
    await expect(
      completeRefund(STELLAR_TX_HASH, undefined, SCHOOL_ID),
    ).rejects.toThrow('refundTxHash is required');

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  // ── Cross-school isolation ──────────────────────────────────────────────────
  // A payment owned by school-other must not be reachable when completeRefund
  // is called with school-test's schoolId — even if the caller supplies the
  // exact txHash of that payment.  This is the core acceptance criterion for
  // the tenant-isolation fix.

  it('cannot act on a payment belonging to a different school (txHash path)', async () => {
    // The DB is modelled: findOne({ txHash, schoolId }) returns null when
    // schoolId doesn't match the stored record — simulating the DB correctly
    // refusing a cross-tenant lookup.
    mockFindOne.mockImplementation(async (filter) => {
      // Only return the payment if the schoolId matches the payment's own school.
      if (filter.schoolId === OTHER_SCHOOL_ID) return makePayment({ schoolId: OTHER_SCHOOL_ID });
      return null; // wrong school → not found
    });

    await expect(
      completeRefund(STELLAR_TX_HASH, REFUND_TX_HASH, SCHOOL_ID),
    ).rejects.toThrow(`Payment not found: ${STELLAR_TX_HASH}`);

    // Every findOne call must have included the caller's schoolId, never the
    // other school's id.
    for (const call of mockFindOne.mock.calls) {
      expect(call[0]).toMatchObject({ schoolId: SCHOOL_ID });
      expect(call[0].schoolId).not.toBe(OTHER_SCHOOL_ID);
    }
  });

  it('cannot act on a payment belonging to a different school (ObjectId path)', async () => {
    mockFindOne.mockImplementation(async (filter) => {
      if (filter.schoolId === OTHER_SCHOOL_ID) return makePayment({ schoolId: OTHER_SCHOOL_ID });
      return null;
    });

    await expect(
      completeRefund(MONGO_ID, REFUND_TX_HASH, SCHOOL_ID),
    ).rejects.toThrow(`Payment not found: ${MONGO_ID}`);

    for (const call of mockFindOne.mock.calls) {
      expect(call[0]).toMatchObject({ schoolId: SCHOOL_ID });
      expect(call[0].schoolId).not.toBe(OTHER_SCHOOL_ID);
    }
  });
});
