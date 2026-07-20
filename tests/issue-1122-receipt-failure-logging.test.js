'use strict';

/**
 * Issue #1122 — receipt-generation failures must never be silently swallowed.
 *
 * paymentController's fire-and-forget createReceipt() call used to end in a bare
 * `.catch(() => {})`, so a systemic receipt outage (bad template, receipt-model
 * fault, downstream dependency down) produced no log line, no metric, and no
 * operational signal of any kind — it would only surface when a parent reported
 * a missing receipt, with no trail to say when it started or why.
 *
 * These tests assert the failure is observable on BOTH receipt paths:
 *   1. the inline verify-controller path (paymentController.verifyPayment)
 *   2. the payment-saved subscriber path
 * and that a failing receipt never breaks the payment response itself — the
 * payment is already on-chain and must still be confirmed to the caller.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';

const TX_HASH = 'a'.repeat(64);
const SCHOOL_ID = 'SCH-1122';
const STUDENT_ID = 'STU-1122';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
mockLogger.child = jest.fn(() => mockLogger);
jest.mock('../backend/src/utils/logger', () => mockLogger);

const receiptError = Object.assign(new Error('receipt template missing'), {
  stack: 'Error: receipt template missing\n    at renderTemplate',
});
const mockCreateReceipt = jest.fn(() => Promise.reject(receiptError));
jest.mock('../backend/src/services/receiptService', () => ({
  createReceipt: mockCreateReceipt,
  getReceiptByTxHash: jest.fn(),
}));

const mockReceiptFailures = { inc: jest.fn() };
jest.mock('../backend/src/metrics', () => ({
  receiptGenerationFailuresTotal: mockReceiptFailures,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Networks: { PUBLIC: 'public', TESTNET: 'testnet' },
  Asset: { native: () => ({ code: 'XLM' }) },
}), { virtual: true });

jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn(() => Promise.resolve({
    hash: 'a'.repeat(64),
    amount: 250,
    memo: 'STU-1122',
    studentId: 'STU-1122',
    assetCode: 'XLM',
    feeAmount: 250,
    networkFee: 0.00001,
    ledger: 42,
    date: '2026-01-01T00:00:00.000Z',
    senderAddress: 'GSENDER',
  })),
  recordPayment: jest.fn(() => Promise.resolve()),
  validatePaymentWithDynamicFee: jest.fn(),
}));

jest.mock('../backend/src/services/distributedLock', () => ({
  acquire: jest.fn(() => Promise.resolve({ token: 't', fencingToken: 1 })),
  release: jest.fn(() => Promise.resolve()),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn(() => Promise.resolve({
    available: false, localAmount: null, currency: 'USD', rate: null, rateTimestamp: null,
  })),
}));

jest.mock('../backend/src/utils/paymentAuditLogger', () => ({
  makePaymentAuditLogger: () => ({
    success: jest.fn(() => Promise.resolve()),
    failure: jest.fn(() => Promise.resolve()),
  }),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn(() => Promise.resolve(null)),
  aggregate: jest.fn(() => Promise.resolve([])),
  create: jest.fn(() => Promise.resolve()),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn(() => Promise.resolve(null)),
  findByIdAndUpdate: jest.fn(() => Promise.resolve()),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn(() => Promise.resolve({
    schoolId: 'SCH-1122', studentId: 'STU-1122', name: 'Test Student', feeAmount: 250,
  })),
  findOneAndUpdate: jest.fn(() => Promise.resolve()),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {},
  ACCEPTED_ASSETS: [{ code: 'XLM', type: 'native' }],
}));

const { verifyPayment } = require('../backend/src/controllers/paymentController');

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildReqRes() {
  const req = {
    schoolId: SCHOOL_ID,
    correlationId: 'corr-1122',
    body: { txHash: TX_HASH },
    school: { schoolId: SCHOOL_ID, stellarAddress: 'GSCHOOL', localCurrency: 'USD' },
  };
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  return { req, res };
}

/** Let the fire-and-forget receipt rejection settle before asserting. */
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('#1122 — verify-controller receipt failures are logged, not swallowed', () => {
  beforeEach(() => {
    mockLogger.error.mockClear();
    mockReceiptFailures.inc.mockClear();
    mockCreateReceipt.mockClear();
  });

  test('a failing createReceipt produces an error log with diagnostic context', async () => {
    const { req, res } = buildReqRes();

    await verifyPayment(req, res, jest.fn());
    await flushMicrotasks();

    expect(mockCreateReceipt).toHaveBeenCalledTimes(1);

    const receiptLog = mockLogger.error.mock.calls.find(([msg]) => /receipt/i.test(msg));
    expect(receiptLog).toBeDefined();

    // Context must be enough to diagnose root cause: which payment, which
    // tenant/student, and the underlying error itself.
    const [, context] = receiptLog;
    expect(context).toMatchObject({
      txHash: TX_HASH,
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      error: 'receipt template missing',
    });
    expect(context.stack).toContain('renderTemplate');
  });

  test('a failing createReceipt increments the receipt-failure metric', async () => {
    const { req, res } = buildReqRes();

    await verifyPayment(req, res, jest.fn());
    await flushMicrotasks();

    expect(mockReceiptFailures.inc).toHaveBeenCalledWith({ source: 'verify_controller' });
  });

  test('the payment is still confirmed to the caller despite the receipt failure', async () => {
    const { req, res } = buildReqRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);
    await flushMicrotasks();

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, hash: TX_HASH }),
    );
  });

  test('a successful createReceipt logs no receipt error and moves no metric', async () => {
    mockCreateReceipt.mockImplementationOnce(() => Promise.resolve({ txHash: TX_HASH }));
    const { req, res } = buildReqRes();

    await verifyPayment(req, res, jest.fn());
    await flushMicrotasks();

    expect(mockLogger.error.mock.calls.filter(([msg]) => /receipt/i.test(msg))).toHaveLength(0);
    expect(mockReceiptFailures.inc).not.toHaveBeenCalled();
  });
});

describe('#1122 — subscriber receipt failures are also metered', () => {
  beforeEach(() => {
    mockLogger.error.mockClear();
    mockReceiptFailures.inc.mockClear();
    mockCreateReceipt.mockClear();
  });

  test('onPaymentSavedReceipt logs and increments on failure without throwing', async () => {
    const { onPaymentSavedReceipt } = require('../backend/src/services/paymentSavedSubscribers');

    await expect(
      onPaymentSavedReceipt({ txHash: TX_HASH, schoolId: SCHOOL_ID, studentId: STUDENT_ID }),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Receipt subscriber failed',
      expect.objectContaining({ txHash: TX_HASH, error: 'receipt template missing' }),
    );
    expect(mockReceiptFailures.inc).toHaveBeenCalledWith({ source: 'payment_saved_subscriber' });
  });
});
