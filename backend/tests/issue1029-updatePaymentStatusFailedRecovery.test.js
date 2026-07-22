'use strict';

/**
 * Tests for Issue #1029 — admin recovery path for FAILED payments via the
 * existing PATCH /api/payments/:txHash/status endpoint (updatePaymentStatus).
 *
 * Acceptance criteria:
 *   1. An admin using updatePaymentStatus with override privileges can move a
 *      FAILED payment to a corrected terminal state (SUCCESS or DISPUTED).
 *   2. Doing so writes an audit log entry with before/after status and the
 *      acting operator.
 *   3. Transitions that were never opened up (e.g. FAILED -> PENDING) are
 *      still rejected with INVALID_TRANSITION.
 */

// Variables must have a 'mock' prefix so jest.mock()'s hoisted factory can
// reference them (jest lint rule for uninitialized mock variables).
let mockSave = jest.fn();
let mockPaymentDoc = null;
let mockFindOneImpl = jest.fn();

jest.mock('../src/models/paymentModel', () => ({
  findOne: (...args) => mockFindOneImpl(...args),
}));

jest.mock('../src/models/receiptModel', () => ({}));
jest.mock('../src/models/refundModel', () => ({}));
jest.mock('../src/models/reconciliationReportModel', () => ({}));
jest.mock('../src/services/receiptService', () => ({
  createReceipt: jest.fn(),
  verifyReceiptSignature: jest.fn(),
}));
jest.mock('../src/services/stellarService', () => ({
  finalizeConfirmedPayments: jest.fn(),
  syncPaymentsForSchool: jest.fn(),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/metrics', () => ({
  syncDurationSeconds: { startTimer: () => jest.fn() },
}));
jest.mock('../src/services/refundService', () => ({
  initiateRefund: jest.fn(),
  getRefundsByPayment: jest.fn(),
  getRefundsBySchool: jest.fn(),
}));
jest.mock('../src/services/reconciliationService', () => ({
  generateReconciliationReport: jest.fn(),
}));
jest.mock('../src/services/distributedLock', () => ({
  acquire: jest.fn(),
  release: jest.fn(),
  withLock: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

process.env.MONGO_URI = 'mongodb://localhost/test';
process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long';

const { updatePaymentStatus } = require('../src/controllers/paymentAdminController');
const { logAudit } = require('../src/services/auditService');

function buildFailedPayment(overrides = {}) {
  mockSave = jest.fn(function save() {
    // Mirror the real pre-save guard's effect closely enough for controller
    // tests: applying the new status is all callers observe post-save.
    return Promise.resolve(this);
  });

  mockPaymentDoc = {
    schoolId: 'school-1',
    txHash: 'tx-failed-1',
    status: 'FAILED',
    $locals: {},
    save: mockSave,
    ...overrides,
  };
  return mockPaymentDoc;
}

function buildReq({ txHash = 'tx-failed-1', status, reason = 'manual reconciliation confirmed funds arrived' } = {}) {
  return {
    schoolId: 'school-1',
    params: { txHash },
    body: { status, reason },
    auditContext: {
      performedBy: 'admin-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    },
  };
}

function buildRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Issue #1029 — updatePaymentStatus admin recovery from FAILED', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows an admin to move a FAILED payment to SUCCESS and audits the transition', async () => {
    const payment = buildFailedPayment();
    mockFindOneImpl.mockResolvedValue(payment);

    const req = buildReq({ status: 'SUCCESS' });
    const res = buildRes();
    const next = jest.fn();

    await updatePaymentStatus(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(payment.status).toBe('SUCCESS');
    // The controller must mark this as an admin-override save so the model's
    // pre-save guard uses the wider transition table.
    expect(payment.$locals.adminOverride).toBe(true);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment_status_update',
        performedBy: 'admin-1',
        targetId: 'tx-failed-1',
        details: expect.objectContaining({ from: 'FAILED', to: 'SUCCESS', adminOverride: true }),
        result: 'success',
      }),
    );
  });

  it('allows an admin to move a FAILED payment to DISPUTED and audits the transition', async () => {
    const payment = buildFailedPayment({ txHash: 'tx-failed-2' });
    mockFindOneImpl.mockResolvedValue(payment);

    const req = buildReq({ txHash: 'tx-failed-2', status: 'DISPUTED' });
    const res = buildRes();
    const next = jest.fn();

    await updatePaymentStatus(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(payment.status).toBe('DISPUTED');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ from: 'FAILED', to: 'DISPUTED' }),
      }),
    );
  });

  it('still rejects FAILED -> PENDING as an invalid transition', async () => {
    const payment = buildFailedPayment();
    mockFindOneImpl.mockResolvedValue(payment);

    const req = buildReq({ status: 'PENDING' });
    const res = buildRes();
    const next = jest.fn();

    await updatePaymentStatus(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('still rejects FAILED -> REFUNDED (not part of the newly-allowed set)', async () => {
    const payment = buildFailedPayment();
    mockFindOneImpl.mockResolvedValue(payment);

    const req = buildReq({ status: 'REFUNDED' });
    const res = buildRes();
    const next = jest.fn();

    await updatePaymentStatus(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});
