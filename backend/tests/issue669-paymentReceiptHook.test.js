'use strict';

/**
 * Tests for Issue #669 — post('save') receipt-email / cache-invalidation hook
 * on the Payment model.
 *
 * The hook previously required './emailService' from backend/src/models/,
 * which does not exist (the file lives in backend/src/services/). That
 * MODULE_NOT_FOUND was swallowed by a catch block wrapping both the email
 * dispatch AND the unrelated report-cache invalidation, so a broken email
 * path silently disabled cache invalidation too.
 *
 * These tests exercise the post-save hook directly (via kareem's execPost,
 * matching the execPre pattern used in paymentModelValidation.test.js) so
 * they run without a real MongoDB connection.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/plugins/tenantScope', () => () => {});
jest.mock('../src/services/paymentConfirmationStateMachine', () => ({
  CONFIRMATION_STATES: {
    DETECTED: 'detected', PENDING: 'pending', CONFIRMED: 'confirmed', FINALIZED: 'finalized', FAILED: 'failed',
  },
  CONFIRMATION_STATE_TRANSITIONS: {
    detected: ['pending', 'failed'],
    pending: ['confirmed', 'failed'],
    confirmed: ['finalized', 'failed'],
    finalized: [],
    failed: [],
  },
  isConfirmedOrAbove: (s) => ['confirmed', 'finalized'].includes(s),
  deriveLegacyConfirmationStatus: (s) =>
    ['confirmed', 'finalized'].includes(s) ? 'confirmed' : s === 'failed' ? 'failed' : 'pending_confirmation',
}));

const studentFindOne = jest.fn();
jest.mock('../src/models/studentModel', () => ({ findOne: (...args) => studentFindOne(...args) }));

const sendPaymentReceipt = jest.fn();
jest.mock('../src/services/emailService', () => ({
  sendPaymentReceipt: (...args) => sendPaymentReceipt(...args),
}));

const invalidate = jest.fn();
jest.mock('../src/services/reportCacheInvalidator', () => ({
  invalidate: (...args) => invalidate(...args),
}));

const logger = require('../src/utils/logger');

let Payment;
beforeAll(() => {
  jest.isolateModules(() => {
    Payment = require('../src/models/paymentModel');
  });
});

function makePayment(overrides = {}) {
  return new Payment({
    schoolId: 'school-1',
    studentId: 'STU001',
    txHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    amount: 100,
    assetCode: 'XLM',
    status: 'PENDING',
    ...overrides,
  });
}

// Simulate a status transition to SUCCESS and invoke the post-save hook
// registered on the schema, without touching a real database.
function transitionToSuccess(doc) {
  doc.$__.savedState = { status: 'PENDING' };
  doc.status = 'SUCCESS';
  return new Promise((resolve, reject) => {
    doc.schema.s.hooks.execPost('save', doc, [doc], (err) => (err ? reject(err) : resolve()));
  });
}

describe('Issue #669 — Payment post(save) receipt/cache hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends a payment receipt email when a student with a parentEmail transitions to SUCCESS', async () => {
    studentFindOne.mockResolvedValue({
      name: 'Jane Doe',
      parentEmail: 'parent@example.com',
      feeAmount: 500,
      totalPaid: 100,
    });
    sendPaymentReceipt.mockResolvedValue({ sent: true });

    const doc = makePayment();
    await transitionToSuccess(doc);

    expect(sendPaymentReceipt).toHaveBeenCalledTimes(1);
    expect(sendPaymentReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'parent@example.com', schoolId: 'school-1', studentId: 'STU001' }),
    );
  });

  it('still invalidates the report cache when sending the receipt email fails', async () => {
    studentFindOne.mockResolvedValue({
      name: 'Jane Doe',
      parentEmail: 'parent@example.com',
      feeAmount: 500,
      totalPaid: 100,
    });
    sendPaymentReceipt.mockRejectedValue(new Error('provider unreachable'));

    const doc = makePayment();
    await transitionToSuccess(doc);

    expect(sendPaymentReceipt).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('school-1');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('receipt email') }),
    );
  });

  it('invalidates the report cache for a student without a parentEmail on file', async () => {
    studentFindOne.mockResolvedValue({
      name: 'John Doe',
      parentEmail: null,
      feeAmount: 500,
      totalPaid: 100,
    });

    const doc = makePayment();
    await transitionToSuccess(doc);

    expect(sendPaymentReceipt).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('school-1');
  });

  it('does not run the hook body when status does not transition to SUCCESS', async () => {
    studentFindOne.mockResolvedValue({ parentEmail: 'parent@example.com' });

    const doc = makePayment({ status: 'PENDING' });
    doc.$__.savedState = { status: 'PENDING' };
    await new Promise((resolve, reject) => {
      doc.schema.s.hooks.execPost('save', doc, [doc], (err) => (err ? reject(err) : resolve()));
    });

    expect(studentFindOne).not.toHaveBeenCalled();
    expect(sendPaymentReceipt).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
