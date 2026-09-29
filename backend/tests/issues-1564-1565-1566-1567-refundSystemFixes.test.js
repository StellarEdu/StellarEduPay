'use strict';

/**
 * Tests for issues #1564, #1565, #1566, #1567 — refund system fixes:
 *
 *   #1567 — Partial refunds (amount ≤ refundable) and refund rejection.
 *   #1566 — Atomic writes (MongoDB session.withTransaction for all three write
 *            functions).
 *   #1565 — Two-person approval with structured { userId, displayName }
 *            principals; unknown principals are rejected.
 *   #1564 — Full execution flow: initiateRefund → approveRefund → completeRefund,
 *            and initiateRefund → rejectRefund; updateRefundStatus emits
 *            refund.status_changed.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  info: () => {},
  warn: () => {},
  error: () => {},
}));

// ── paymentEvents mock ────────────────────────────────────────────────────────
const mockPaymentEventsEmit = jest.fn();
jest.mock('../src/events/paymentEvents', () => ({
  emit: (...args) => mockPaymentEventsEmit(...args),
  on: jest.fn(),
}));

// ── studentBalanceUpdater mock ─────────────────────────────────────────────────
const mockUpdateStudentBalance = jest.fn().mockResolvedValue({ feePaid: false });
jest.mock('../src/utils/studentBalanceUpdater', () => ({
  updateStudentBalance: (...args) => mockUpdateStudentBalance(...args),
}));

// ── Model mocks ──────────────────────────────────────────────────────────────

const mockPaymentFindOne = jest.fn();
const mockPaymentSave = jest.fn();
jest.mock('../src/models/paymentModel', () => ({
  findOne: (...args) => mockPaymentFindOne(...args),
  aggregate: jest.fn().mockResolvedValue([]),
}));

const mockRefundFindById = jest.fn();
const mockRefundFindOne = jest.fn();
const mockRefundCreate = jest.fn();
const mockRefundAggregate = jest.fn().mockResolvedValue([]);
jest.mock('../src/models/refundModel', () => ({
  findById: (...args) => mockRefundFindById(...args),
  findOne: (...args) => mockRefundFindOne(...args),
  create: (...args) => mockRefundCreate(...args),
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  }),
  aggregate: (...args) => mockRefundAggregate(...args),
}));

const mockOutboxCreate = jest.fn().mockResolvedValue({});
jest.mock('../src/models/outboxModel', () => ({
  create: (...args) => mockOutboxCreate(...args),
}));

// ── MongoDB session mock (#1566) ─────────────────────────────────────────────
// Simulates session.withTransaction executing the callback synchronously so
// the tests can assert that writes happen inside the transaction boundary.
const mockSessionWithTransaction = jest.fn().mockImplementation(async (cb) => cb());
const mockSessionEndSession = jest.fn().mockResolvedValue(undefined);
const mockMongooseConnection = {
  startSession: jest.fn().mockResolvedValue({
    withTransaction: mockSessionWithTransaction,
    endSession: mockSessionEndSession,
  }),
};
jest.mock('mongoose', () => ({
  connection: mockMongooseConnection,
}));

// ── Distributed lock mock ────────────────────────────────────────────────────
const mockLockAcquire = jest.fn();
const mockLockRelease = jest.fn().mockResolvedValue(true);
jest.mock('../src/services/distributedLock', () => ({
  acquire: (...args) => mockLockAcquire(...args),
  release: (...args) => mockLockRelease(...args),
  _resetLocalLocks: jest.fn(),
}));

// ── Stellar amount util ──────────────────────────────────────────────────────
jest.mock('../src/utils/stellarAmount', () => ({
  amountsEqual: (a, b) => a === b,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
const SCHOOL_ID = 'SCH-TEST';
const TX_HASH = 'abc123txhash';
const STUDENT_ID = 'STU-001';
const PAYMENT_AMOUNT = 200;
const REFUND_TX = 'def456refundtx';
const REASON = 'student withdrew mid-term';

const PRINCIPAL_A = { userId: 'user-alice', displayName: 'Alice' };
const PRINCIPAL_B = { userId: 'user-bob', displayName: 'Bob' };

function mockSuccessPayment(amount = PAYMENT_AMOUNT) {
  return {
    schoolId: SCHOOL_ID,
    txHash: TX_HASH,
    studentId: STUDENT_ID,
    amount,
    status: 'SUCCESS',
    $locals: {},
    save: mockPaymentSave,
  };
}

function mockRefund(status = 'approval_pending', amount = 100) {
  const doc = {
    _id: 'refund-id-001',
    schoolId: SCHOOL_ID,
    originalTxHash: TX_HASH,
    studentId: STUDENT_ID,
    amount,
    status,
    initiatedBy: PRINCIPAL_A,
    approvedBy: null,
    rejectedBy: null,
    refundTxHash: null,
    confirmedAt: null,
    failureReason: null,
    failedAt: null,
    rejectionReason: null,
    rejectedAt: null,
    save: jest.fn().mockImplementation(async function () { return this; }),
  };
  return doc;
}

// ── Import service AFTER all mocks ───────────────────────────────────────────
const {
  initiateRefund,
  approveRefund,
  rejectRefund,
  completeRefund,
  updateRefundStatus,
  buildPrincipal,
  refundLockKey,
  ACTIVE_REFUND_STATUSES,
  VALID_REFUND_STATUSES,
  REFUND_STATUS_TRANSITIONS,
} = require('../src/services/refundService');

// ── Reset state between tests ────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  mockLockAcquire.mockResolvedValue({ token: 'tok-1', fencingToken: 1 });
  mockPaymentFindOne.mockResolvedValue(mockSuccessPayment());
  mockRefundFindOne.mockResolvedValue(null);
  mockRefundAggregate.mockResolvedValue([]);
  mockRefundCreate.mockImplementation(async (docs) => {
    const doc = Array.isArray(docs) ? docs[0] : docs;
    return [{ _id: 'new-refund-id', ...doc }];
  });
  mockPaymentSave.mockResolvedValue(true);
  mockOutboxCreate.mockResolvedValue({});
  mockUpdateStudentBalance.mockResolvedValue({ feePaid: false });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildPrincipal (#1565)
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildPrincipal (#1565)', () => {
  it('uses admin.id as userId when present', () => {
    const admin = { id: 'mongo-id-123', email: 'alice@school.edu' };
    const ctx = { performedBy: 'alice@school.edu' };
    const p = buildPrincipal(ctx, admin);
    expect(p.userId).toBe('mongo-id-123');
    expect(p.displayName).toBe('alice@school.edu');
  });

  it('falls back to admin.userId (env super-admin)', () => {
    const admin = { userId: 'super_admin' };
    const ctx = { performedBy: 'super_admin' };
    const p = buildPrincipal(ctx, admin);
    expect(p.userId).toBe('super_admin');
  });

  it('throws UNKNOWN_PRINCIPAL when only "unknown" is available', () => {
    const ctx = { performedBy: 'unknown' };
    expect(() => buildPrincipal(ctx, {})).toThrow(expect.objectContaining({ code: 'UNKNOWN_PRINCIPAL' }));
  });

  it('throws UNKNOWN_PRINCIPAL when nothing is available', () => {
    expect(() => buildPrincipal({}, null)).toThrow(expect.objectContaining({ code: 'UNKNOWN_PRINCIPAL' }));
  });

  it('uses email as displayName when id is present', () => {
    const p = buildPrincipal({ performedBy: 'bob' }, { id: 'bob-id', email: 'bob@edu.org' });
    expect(p.displayName).toBe('bob@edu.org');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// initiateRefund — partial refunds (#1567)
// ═══════════════════════════════════════════════════════════════════════════════

describe('initiateRefund — partial refunds (#1567)', () => {
  it('accepts a partial refund amount less than payment.amount', async () => {
    const partialAmount = 75;
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, partialAmount, REASON, PRINCIPAL_A);
    expect(mockRefundCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ amount: partialAmount })]),
      expect.anything(),
    );
  });

  it('accepts a full refund equal to payment.amount', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, PAYMENT_AMOUNT, REASON, PRINCIPAL_A);
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects amount > payment.amount with AMOUNT_EXCEEDS_REFUNDABLE', async () => {
    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, PAYMENT_AMOUNT + 1, REASON, PRINCIPAL_A)
      .catch(e => e);
    expect(err.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
    expect(err.refundable).toBe(PAYMENT_AMOUNT);
  });

  it('accounts for already-confirmed refunds when computing refundable amount', async () => {
    // 80 already refunded → only 120 remains
    mockRefundAggregate.mockResolvedValueOnce([{ total: 80 }]);
    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 150, REASON, PRINCIPAL_A)
      .catch(e => e);
    expect(err.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
    expect(err.alreadyRefunded).toBe(80);
    expect(err.refundable).toBe(120);
  });

  it('allows a second partial refund if first was already confirmed and deducted', async () => {
    mockRefundAggregate.mockResolvedValueOnce([{ total: 50 }]);
    mockRefundFindOne.mockResolvedValueOnce(null); // no active refund
    await expect(
      initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A)
    ).resolves.toBeDefined();
  });

  it('rejects zero amount', async () => {
    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 0, REASON, PRINCIPAL_A).catch(e => e);
    expect(err.code).toBe('INVALID_AMOUNT');
  });

  it('rejects negative amount', async () => {
    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, -10, REASON, PRINCIPAL_A).catch(e => e);
    expect(err.code).toBe('INVALID_AMOUNT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// initiateRefund — identity (#1565)
// ═══════════════════════════════════════════════════════════════════════════════

describe('initiateRefund — identity (#1565)', () => {
  it('stores initiatedBy as { userId, displayName }', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(mockRefundCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ initiatedBy: PRINCIPAL_A })]),
      expect.anything(),
    );
  });

  it('throws UNKNOWN_PRINCIPAL for unknown userId', async () => {
    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, { userId: 'unknown', displayName: 'unknown' })
      .catch(e => e);
    expect(err.code).toBe('UNKNOWN_PRINCIPAL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// initiateRefund — atomic writes (#1566)
// ═══════════════════════════════════════════════════════════════════════════════

describe('initiateRefund — atomic writes (#1566)', () => {
  it('opens a MongoDB session and uses withTransaction', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(mockMongooseConnection.startSession).toHaveBeenCalledTimes(1);
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it('passes the session to Refund.create', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(mockRefundCreate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ session: expect.anything() }),
    );
  });

  it('passes the session to Payment.save and Outbox.create', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(mockPaymentSave).toHaveBeenCalledWith(expect.objectContaining({ session: expect.anything() }));
    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ session: expect.anything() }),
    );
  });

  it('sets payment status to REFUND_PENDING (not immediately REFUNDED)', async () => {
    const payment = mockSuccessPayment();
    mockPaymentFindOne.mockResolvedValueOnce(payment);
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(payment.status).toBe('REFUND_PENDING');
  });

  it('writes refund.initiated Outbox event', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ eventType: 'refund.initiated' })]),
      expect.anything(),
    );
  });

  it('endSession is always called even when withTransaction throws', async () => {
    mockSessionWithTransaction.mockRejectedValueOnce(new Error('write conflict'));
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A).catch(() => {});
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// approveRefund — two-person approval (#1565)
// ═══════════════════════════════════════════════════════════════════════════════

describe('approveRefund — two-person approval (#1565)', () => {
  beforeEach(() => {
    mockRefundFindById.mockResolvedValue(mockRefund('approval_pending'));
  });

  it('succeeds when approver is a different user than initiator', async () => {
    await expect(approveRefund('refund-id-001', PRINCIPAL_B)).resolves.toBeDefined();
  });

  it('rejects when approver has same userId as initiator (SELF_APPROVAL_NOT_ALLOWED)', async () => {
    const err = await approveRefund('refund-id-001', PRINCIPAL_A).catch(e => e);
    expect(err.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
  });

  it('rejects UNKNOWN_PRINCIPAL approver', async () => {
    const err = await approveRefund('refund-id-001', { userId: 'unknown', displayName: 'unknown' }).catch(e => e);
    expect(err.code).toBe('UNKNOWN_PRINCIPAL');
  });

  it('stores approvedBy as { userId, displayName }', async () => {
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await approveRefund('refund-id-001', PRINCIPAL_B);
    expect(doc.approvedBy).toEqual(PRINCIPAL_B);
  });

  it('wraps save and outbox in a transaction (#1566)', async () => {
    await approveRefund('refund-id-001', PRINCIPAL_B);
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it('rejects when refund is not in approval_pending status', async () => {
    mockRefundFindById.mockResolvedValue(mockRefund('pending'));
    const err = await approveRefund('refund-id-001', PRINCIPAL_B).catch(e => e);
    expect(err.code).toBe('INVALID_STATE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rejectRefund (#1567 / #1564)
// ═══════════════════════════════════════════════════════════════════════════════

describe('rejectRefund (#1567 / #1564)', () => {
  beforeEach(() => {
    mockRefundFindById.mockResolvedValue(mockRefund('approval_pending'));
    mockPaymentFindOne.mockResolvedValue({
      schoolId: SCHOOL_ID,
      txHash: TX_HASH,
      studentId: STUDENT_ID,
      status: 'REFUND_PENDING',
      $locals: {},
      save: mockPaymentSave,
    });
    mockLockAcquire.mockResolvedValue({ token: 'tok-reject', fencingToken: 2 });
  });

  it('moves refund to rejected status', async () => {
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'no longer needed');
    expect(doc.status).toBe('rejected');
  });

  it('records rejectedBy, rejectedAt, and rejectionReason', async () => {
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'no longer needed');
    expect(doc.rejectedBy).toEqual(PRINCIPAL_B);
    expect(doc.rejectedAt).toBeInstanceOf(Date);
    expect(doc.rejectionReason).toBe('no longer needed');
  });

  it('restores payment status to SUCCESS', async () => {
    const payment = {
      schoolId: SCHOOL_ID, txHash: TX_HASH, status: 'REFUND_PENDING',
      $locals: {}, save: mockPaymentSave,
    };
    mockPaymentFindOne.mockResolvedValueOnce(payment);
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'denied');
    expect(payment.status).toBe('SUCCESS');
  });

  it('prevents self-rejection (SELF_APPROVAL_NOT_ALLOWED)', async () => {
    const err = await rejectRefund('refund-id-001', PRINCIPAL_A, 'denied').catch(e => e);
    expect(err.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
  });

  it('requires a rejection reason', async () => {
    const err = await rejectRefund('refund-id-001', PRINCIPAL_B, '').catch(e => e);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('only works on approval_pending refunds', async () => {
    mockRefundFindById.mockResolvedValue(mockRefund('pending'));
    const err = await rejectRefund('refund-id-001', PRINCIPAL_B, 'denied').catch(e => e);
    expect(err.code).toBe('INVALID_STATE');
  });

  it('wraps all writes in a MongoDB transaction (#1566)', async () => {
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'denied');
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it('writes a refund.rejected Outbox event', async () => {
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'denied');
    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ eventType: 'refund.rejected' })]),
      expect.anything(),
    );
  });

  it('emits refund.status_changed in-process event (#1564)', async () => {
    const doc = mockRefund('approval_pending');
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'denied');
    expect(mockPaymentEventsEmit).toHaveBeenCalledWith(
      'refund.status_changed',
      expect.objectContaining({ newStatus: 'rejected' }),
    );
  });

  it('releases the lock even when save throws', async () => {
    const doc = mockRefund('approval_pending');
    doc.save.mockRejectedValueOnce(new Error('DB error'));
    mockRefundFindById.mockResolvedValue(doc);
    await rejectRefund('refund-id-001', PRINCIPAL_B, 'denied').catch(() => {});
    expect(mockLockRelease).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// completeRefund (#1564)
// ═══════════════════════════════════════════════════════════════════════════════

describe('completeRefund (#1564)', () => {
  beforeEach(() => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    mockPaymentFindOne.mockResolvedValue({
      schoolId: SCHOOL_ID, txHash: TX_HASH, status: 'REFUND_PENDING',
      $locals: {}, save: mockPaymentSave,
    });
    mockLockAcquire.mockResolvedValue({ token: 'tok-complete', fencingToken: 3 });
  });

  it('moves refund to confirmed with refundTxHash', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B);
    expect(doc.status).toBe('confirmed');
    expect(doc.refundTxHash).toBe(REFUND_TX);
    expect(doc.confirmedAt).toBeInstanceOf(Date);
  });

  it('marks payment as REFUNDED', async () => {
    const payment = {
      schoolId: SCHOOL_ID, txHash: TX_HASH, status: 'REFUND_PENDING',
      $locals: {}, save: mockPaymentSave,
    };
    mockPaymentFindOne.mockResolvedValueOnce(payment);
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B);
    expect(payment.status).toBe('REFUNDED');
  });

  it('requires refundTxHash', async () => {
    const err = await completeRefund('refund-id-001', '', PRINCIPAL_B).catch(e => e);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('only works on pending refunds', async () => {
    mockRefundFindById.mockResolvedValue(mockRefund('approval_pending'));
    const err = await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B).catch(e => e);
    expect(err.code).toBe('INVALID_STATE');
  });

  it('wraps all writes in a MongoDB transaction (#1566)', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B);
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it('writes a refund.status_changed Outbox event (#1564)', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B);
    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({
        eventType: 'refund.status_changed',
        payload: expect.objectContaining({ newStatus: 'confirmed', refundTxHash: REFUND_TX }),
      })]),
      expect.anything(),
    );
  });

  it('emits in-process refund.status_changed event after transaction commits (#1564)', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B);
    expect(mockPaymentEventsEmit).toHaveBeenCalledWith(
      'refund.status_changed',
      expect.objectContaining({ newStatus: 'confirmed', refundTxHash: REFUND_TX }),
    );
  });

  it('calls updateStudentBalance after completion (#1567)', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    await completeRefund('refund-id-001', REFUND_TX, PRINCIPAL_B);
    expect(mockUpdateStudentBalance).toHaveBeenCalledWith(SCHOOL_ID, STUDENT_ID, {});
  });

  it('rejects UNKNOWN_PRINCIPAL', async () => {
    const err = await completeRefund('refund-id-001', REFUND_TX, { userId: 'unknown', displayName: '' }).catch(e => e);
    expect(err.code).toBe('UNKNOWN_PRINCIPAL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end flow: initiate → approve → complete (#1564)
// ═══════════════════════════════════════════════════════════════════════════════

describe('end-to-end flow: initiate → approve → complete (#1564)', () => {
  it('completes the full happy path with two distinct principals', async () => {
    // Initiate (Alice)
    const payment = mockSuccessPayment();
    mockPaymentFindOne.mockResolvedValue(payment);
    mockRefundFindOne.mockResolvedValue(null);

    const createdRefund = { _id: 'ref-001', schoolId: SCHOOL_ID, originalTxHash: TX_HASH, studentId: STUDENT_ID, amount: 100, status: 'approval_pending', initiatedBy: PRINCIPAL_A };
    mockRefundCreate.mockResolvedValueOnce([createdRefund]);

    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 100, REASON, PRINCIPAL_A);
    expect(payment.status).toBe('REFUND_PENDING');

    // Approve (Bob)
    const pendingRefund = mockRefund('approval_pending', 100);
    mockRefundFindById.mockResolvedValue(pendingRefund);
    await approveRefund('ref-001', PRINCIPAL_B);
    expect(pendingRefund.status).toBe('pending');

    // Complete (Bob or another operator)
    const approvedRefund = mockRefund('pending', 100);
    mockRefundFindById.mockResolvedValue(approvedRefund);
    const paymentInProgress = {
      schoolId: SCHOOL_ID, txHash: TX_HASH, status: 'REFUND_PENDING',
      $locals: {}, save: mockPaymentSave,
    };
    mockPaymentFindOne.mockResolvedValueOnce(paymentInProgress);
    mockLockAcquire.mockResolvedValue({ token: 'tok-complete', fencingToken: 4 });

    await completeRefund('ref-001', REFUND_TX, PRINCIPAL_B);
    expect(approvedRefund.status).toBe('confirmed');
    expect(paymentInProgress.status).toBe('REFUNDED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end flow: initiate → reject (#1564 / #1567)
// ═══════════════════════════════════════════════════════════════════════════════

describe('end-to-end flow: initiate → reject (#1564 / #1567)', () => {
  it('correctly restores payment to SUCCESS when refund is rejected', async () => {
    const payment = mockSuccessPayment();
    mockPaymentFindOne.mockResolvedValueOnce(payment);
    mockRefundFindOne.mockResolvedValueOnce(null);
    mockRefundCreate.mockResolvedValueOnce([{ _id: 'ref-002', schoolId: SCHOOL_ID, originalTxHash: TX_HASH, studentId: STUDENT_ID, amount: 50, status: 'approval_pending', initiatedBy: PRINCIPAL_A }]);

    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 50, REASON, PRINCIPAL_A);
    expect(payment.status).toBe('REFUND_PENDING');

    // Reject (Bob)
    const pendingRefund = mockRefund('approval_pending', 50);
    mockRefundFindById.mockResolvedValue(pendingRefund);
    const paymentInProgress = {
      schoolId: SCHOOL_ID, txHash: TX_HASH, status: 'REFUND_PENDING',
      $locals: {}, save: mockPaymentSave,
    };
    mockPaymentFindOne.mockResolvedValueOnce(paymentInProgress);
    mockLockAcquire.mockResolvedValue({ token: 'tok-reject', fencingToken: 5 });

    await rejectRefund('ref-002', PRINCIPAL_B, 'request denied by finance');
    expect(pendingRefund.status).toBe('rejected');
    expect(paymentInProgress.status).toBe('SUCCESS');

    // Confirm webhooks/SSE fired
    expect(mockPaymentEventsEmit).toHaveBeenCalledWith(
      'refund.status_changed',
      expect.objectContaining({ newStatus: 'rejected' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateRefundStatus — session wrapping (#1566)
// ═══════════════════════════════════════════════════════════════════════════════

describe('updateRefundStatus — atomic writes (#1566)', () => {
  it('opens a session and uses withTransaction', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus('ref-001', 'submitted');

    expect(mockMongooseConnection.startSession).toHaveBeenCalledTimes(1);
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it('always calls endSession even when the transaction throws', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    mockSessionWithTransaction.mockRejectedValueOnce(new Error('conflict'));

    await updateRefundStatus('ref-001', 'submitted').catch(() => {});
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it('emits refund.status_changed in-process event after commit (#1564)', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus('ref-001', 'submitted');

    expect(mockPaymentEventsEmit).toHaveBeenCalledWith(
      'refund.status_changed',
      expect.objectContaining({ previousStatus: 'pending', newStatus: 'submitted' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VALID_REFUND_STATUSES / REFUND_STATUS_TRANSITIONS — now includes rejected
// ═══════════════════════════════════════════════════════════════════════════════

describe('VALID_REFUND_STATUSES includes rejected (#1567)', () => {
  it('contains rejected as a valid status', () => {
    expect(VALID_REFUND_STATUSES).toContain('rejected');
  });

  it('has approval_pending → rejected as an allowed transition', () => {
    expect(REFUND_STATUS_TRANSITIONS.approval_pending).toContain('rejected');
  });

  it('rejected is a terminal state (no outgoing transitions)', () => {
    expect(REFUND_STATUS_TRANSITIONS.rejected).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVE_REFUND_STATUSES does NOT include rejected or failed
// ═══════════════════════════════════════════════════════════════════════════════

describe('ACTIVE_REFUND_STATUSES', () => {
  it('does not include rejected (rejected refunds allow a new refund attempt)', () => {
    expect(ACTIVE_REFUND_STATUSES).not.toContain('rejected');
  });

  it('does not include failed (failed refunds allow a new attempt)', () => {
    expect(ACTIVE_REFUND_STATUSES).not.toContain('failed');
  });

  it('includes all in-progress statuses', () => {
    expect(ACTIVE_REFUND_STATUSES).toEqual(
      expect.arrayContaining(['approval_pending', 'pending', 'submitted', 'confirmed'])
    );
  });
});
