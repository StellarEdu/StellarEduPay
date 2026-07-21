'use strict';

/**
 * End-to-end payment flow test — issue #579
 *
 * Exercises every step of the payment lifecycle using the controller functions
 * directly (no Express / supertest needed) with a fully mocked Stellar SDK
 * and mocked MongoDB models.
 *
 * Scenarios covered:
 *   1. Payment intent creation
 *   2. Exact payment (valid)         → feeValidationStatus: 'valid'
 *   3. Overpayment                   → feeValidationStatus: 'overpaid'
 *   4. Underpayment                  → recorded as 'partial' (#846)
 *   5. Duplicate transaction hash    → 200 cached: true
 *   6. Missing memo                  → 400 MISSING_MEMO
 *   7. Expired payment intent        → recorded anyway, intent marked expired (#848)
 *   8. Sync flow                     → student feePaid updated after sync
 *   9. txHash missing/null/empty     → 400 VALIDATION_ERROR  (#582)
 */

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.MONGO_URI             = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET            = 'test-jwt-secret-e2e-payment-flow';

// ─── Mocks (jest hoists these before any require) ─────────────────────────────

// Stellar SDK is not installed at root level — mock the entire package.
jest.mock('@stellar/stellar-sdk', () => ({
  Transaction: jest.fn(),
  Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
  Memo: { text: jest.fn(() => ({ type: 'text', value: Buffer.from('STU-E2E') })) },
  Asset: { native: jest.fn(() => ({ isNative: () => true })) },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

// Stellar config — provides wallet address and mocked Horizon server.
jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET:        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  networkPassphrase:    'Test SDF Network ; September 2015',
  CONFIRMATION_THRESHOLD: 1,
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          displayName: 'Stellar Lumens', issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', displayName: 'USD Coin',       issuer: 'GISSUER' },
  },
  isAcceptedAsset: jest.fn((code) => ({
    accepted: ['XLM', 'USDC'].includes(code),
    asset: { code, type: code === 'XLM' ? 'native' : 'credit_alphanum4' },
  })),
  server: {
    transactions: jest.fn(() => ({ transaction: jest.fn() })),
    ledgers: jest.fn(() => ({ order: jest.fn(() => ({ limit: jest.fn(() => ({ call: jest.fn().mockResolvedValue({ records: [{ sequence: 100 }] }) })) })) })),
  },
}));

// stellarService — mocked so no real Horizon calls are made.
const mockVerifyTransaction     = jest.fn();
const mockSyncPaymentsForSchool = jest.fn();
const mockRecordPayment         = jest.fn();
jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction:          (...a) => mockVerifyTransaction(...a),
  syncPaymentsForSchool:      (...a) => mockSyncPaymentsForSchool(...a),
  recordPayment:              (...a) => mockRecordPayment(...a),
  finalizeConfirmedPayments:  jest.fn().mockResolvedValue(undefined),
  validatePaymentWithDynamicFee: jest.fn().mockResolvedValue({}),
}));

// Mongoose models — fully mocked so no real MongoDB connection is needed.
const mockPaymentFindOne         = jest.fn();
const mockPaymentCreate          = jest.fn();
const mockPaymentAggregate       = jest.fn();
const mockPaymentCountDocuments  = jest.fn();
jest.mock('../backend/src/models/paymentModel', () => {
  const chain = { sort: jest.fn(), skip: jest.fn(), limit: jest.fn(), lean: jest.fn(), populate: jest.fn() };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockResolvedValue([]);
  chain.populate.mockResolvedValue([]);
  return {
    findOne:        (...a) => mockPaymentFindOne(...a),
    find:           jest.fn().mockReturnValue(chain),
    create:         (...a) => mockPaymentCreate(...a),
    aggregate:      (...a) => mockPaymentAggregate(...a),
    countDocuments: (...a) => mockPaymentCountDocuments(...a),
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    distinct:       jest.fn().mockResolvedValue([]),
  };
});

const mockIntentFindOne        = jest.fn();
const mockIntentCreate         = jest.fn();
const mockIntentFindByIdUpdate = jest.fn();
jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne:          (...a) => mockIntentFindOne(...a),
  create:           (...a) => mockIntentCreate(...a),
  findByIdAndUpdate:(...a) => mockIntentFindByIdUpdate(...a),
}));

const mockStudentFindOne        = jest.fn();
const mockStudentFindOneUpdate  = jest.fn();
const mockStudentCountDocuments = jest.fn();
jest.mock('../backend/src/models/studentModel', () => ({
  findOne:          (...a) => mockStudentFindOne(...a),
  findOneAndUpdate: (...a) => mockStudentFindOneUpdate(...a),
  countDocuments:   (...a) => mockStudentCountDocuments(...a),
  aggregate:        jest.fn().mockResolvedValue([]),
  distinct:         jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  findOne:          jest.fn().mockResolvedValue(null),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/receiptModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create:  jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  findOne: jest.fn().mockResolvedValue({ className: 'Grade 5A', feeAmount: 250 }),
}));

jest.mock('../backend/src/models/systemConfigModel', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue({}),
}));

// Services
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry:       jest.fn().mockResolvedValue(undefined),
  startRetryWorker:    jest.fn(),
  stopRetryWorker:     jest.fn(),
  isRetryWorkerRunning:jest.fn().mockReturnValue(false),
}));
jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency:      jest.fn().mockResolvedValue({ available: false, localAmount: null, currency: 'USD', rate: null, rateTimestamp: null }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) => Promise.resolve(p)),
  _getRates:                   jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/receiptService', () => ({
  createReceipt: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/services/sseService', () => ({
  addClient:           jest.fn(),
  removeClient:        jest.fn(),
  broadcastToSchool:   jest.fn(),
}));

// Queue / infra
jest.mock('../backend/src/queue/transactionQueue', () => ({
  enqueueTransaction: jest.fn().mockResolvedValue({}),
  getJobStatus:       jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(),
  setupMonitoring:      jest.fn(),
  getDeadLetterQueue:   jest.fn().mockReturnValue(null),
  getRetryQueueStatus:  jest.fn().mockResolvedValue({ available: false }),
}));
jest.mock('../backend/src/services/stuckPaymentReconciliation', () => ({
  findStuckPayments:          jest.fn().mockResolvedValue([]),
  STUCK_PAYMENT_THRESHOLD_MS: 300000,
}));

// ─── Controller under test ────────────────────────────────────────────────────
const {
  createPaymentIntent,
  verifyPayment,
  syncAllPayments,
} = require('../backend/src/controllers/paymentController');

// ─── Constants ────────────────────────────────────────────────────────────────
const SCHOOL_ID   = 'SCH001';
const STUDENT_ID  = 'STU-E2E';
const WALLET_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const VALID_HASH  = 'a'.repeat(64);
const DUP_HASH    = 'b'.repeat(64);
const OVER_HASH   = 'c'.repeat(64);
const UNDER_HASH  = 'd'.repeat(64);
const MEMO_HASH   = 'e'.repeat(64);
const EXP_HASH    = 'f'.repeat(64);

const mockStudent = {
  _id: '507f1f77bcf86cd799439011',
  studentId: STUDENT_ID,
  name: 'E2E Student',
  class: 'Grade 5A',
  feeAmount: 250,
  feePaid: false,
  fees: [],
};

/** Build a minimal intent record (non-expired). */
function freshIntent(overrides = {}) {
  const base = {
    _id: 'intent001',
    studentId: STUDENT_ID,
    amount: 250,
    memo: STUDENT_ID,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 h in the future
    ...overrides,
  };
  base.toObject = () => ({ ...base });
  return base;
}

/** Build a minimal verifyTransaction result (exact match by default). */
function txResult(overrides = {}) {
  return {
    hash: VALID_HASH,
    memo: STUDENT_ID,
    studentId: STUDENT_ID,
    amount: 250,
    assetCode: 'XLM',
    assetType: 'native',
    feeAmount: 250,
    feeValidation: { status: 'valid', excessAmount: 0, message: 'Payment matches the required fee' },
    networkFee: 0.00001,
    date: new Date().toISOString(),
    ledger: 12345,
    senderAddress: 'GSENDER123',
    ...overrides,
  };
}

// ─── Request / response helpers ───────────────────────────────────────────────
function makeReq(body = {}, overrides = {}) {
  return {
    body,
    schoolId: SCHOOL_ID,
    school: { stellarAddress: WALLET_ADDR, localCurrency: 'USD' },
    user: { email: 'admin@school.edu' },
    ip: '127.0.0.1',
    connection: {},
    get: jest.fn((h) => h === 'user-agent' ? 'jest-e2e' : undefined),
    ...overrides,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no cached payment, no existing duplicate.
  mockPaymentFindOne.mockResolvedValue(null);
  mockPaymentCreate.mockResolvedValue({ txHash: VALID_HASH, amount: 250, status: 'FAILED' });
  mockPaymentAggregate.mockResolvedValue([]);
  mockPaymentCountDocuments.mockResolvedValue(0);
  mockStudentFindOne.mockResolvedValue(mockStudent);
  mockStudentFindOneUpdate.mockResolvedValue({ ...mockStudent, feePaid: true });
  mockStudentCountDocuments.mockResolvedValue(0);
  mockIntentFindOne.mockResolvedValue(freshIntent());
  mockIntentCreate.mockResolvedValue(freshIntent());
  mockIntentFindByIdUpdate.mockResolvedValue({});
  mockVerifyTransaction.mockResolvedValue(txResult());
  mockRecordPayment.mockResolvedValue({});
  mockSyncPaymentsForSchool.mockResolvedValue({
    found: 1, new: 1, matched: 1, unmatched: 0, failed: 0, alreadyProcessed: 0, failedDetails: [],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Payment intent creation
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Step 2 — createPaymentIntent', () => {
  test('creates a payment intent for a known student and returns intent data', async () => {
    const req  = makeReq({ studentId: STUDENT_ID });
    const res  = makeRes();
    const next = jest.fn();

    await createPaymentIntent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({ studentId: STUDENT_ID, amount: 250, status: 'PENDING' });
  });

  test('returns 404 when student is not found', async () => {
    mockStudentFindOne.mockResolvedValueOnce(null);
    const req  = makeReq({ studentId: 'UNKNOWN' });
    const res  = makeRes();
    const next = jest.fn();

    await createPaymentIntent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 / Scenario 1: Exact payment — valid
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 1 — exact payment (valid)', () => {
  test('verifyPayment records payment with feeValidationStatus "valid" and returns 200', async () => {
    const req  = makeReq({ txHash: VALID_HASH });
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.verified).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.hash).toBe(VALID_HASH);
    expect(body.feeValidation.status).toBe('valid');
    expect(mockRecordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ feeValidationStatus: 'valid', status: 'SUCCESS' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Overpayment
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 2 — overpayment', () => {
  test('verifyPayment records payment with feeValidationStatus "overpaid" and returns 200', async () => {
    mockVerifyTransaction.mockResolvedValueOnce(txResult({
      hash: OVER_HASH,
      amount: 300,
      feeValidation: { status: 'overpaid', excessAmount: 50, message: 'Overpayment of 50 XLM' },
    }));

    const req  = makeReq({ txHash: OVER_HASH });
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.verified).toBe(true);
    expect(body.feeValidation.status).toBe('overpaid');
    expect(body.feeValidation.excessAmount).toBe(50);
    expect(mockRecordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ feeValidationStatus: 'overpaid', excessAmount: 50 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Underpayment — rejected with UNDERPAID
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 3 — underpayment (accepted as partial)', () => {
  // #846: a single payment below the fee is no longer rejected — a parent may be
  // paying in installments and the money is already on-chain. The cumulative
  // total drives the status, so an under-fee amount is recorded as 'partial'.
  test('verifyPayment records the payment as "partial" and does NOT reject', async () => {
    mockVerifyTransaction.mockResolvedValueOnce(txResult({
      hash: UNDER_HASH,
      amount: 100,
      feeAmount: 250,
      feeValidation: { status: 'underpaid', excessAmount: 0, message: 'Payment of 100 is less than the required fee of 250' },
    }));

    const req  = makeReq({ txHash: UNDER_HASH });
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.verified).toBe(true);
    expect(body.feeValidation.status).toBe('partial');
    expect(mockRecordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ feeValidationStatus: 'partial', excessAmount: 0 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Duplicate transaction hash — cached result returned
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 4 — duplicate transaction hash (cached)', () => {
  test('verifyPayment returns cached:true without calling verifyTransaction again', async () => {
    const existingPayment = {
      txHash: DUP_HASH,
      studentId: STUDENT_ID,
      amount: 250,
      memo: STUDENT_ID,
      assetCode: 'XLM',
      assetType: 'native',
      feeAmount: 250,
      feeValidationStatus: 'valid',
      excessAmount: 0,
      networkFee: null,
      confirmedAt: new Date(),
      createdAt: new Date(),
      status: 'SUCCESS',
      confirmationStatus: 'confirmed',
    };
    mockPaymentFindOne.mockResolvedValueOnce(existingPayment);

    const req  = makeReq({ txHash: DUP_HASH });
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyTransaction).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.verified).toBe(true);
    expect(body.cached).toBe(true);
    expect(body.hash).toBe(DUP_HASH);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: Missing memo — rejected with MISSING_MEMO
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 5 — missing memo (MISSING_MEMO)', () => {
  test('verifyPayment calls next() with MISSING_MEMO error and creates a FAILED payment record', async () => {
    const missingMemoErr = Object.assign(new Error('Transaction has no memo'), { code: 'MISSING_MEMO' });
    mockVerifyTransaction.mockRejectedValueOnce(missingMemoErr);

    const req  = makeReq({ txHash: MEMO_HASH });
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    // Error forwarded to global error handler (→ 400 MISSING_MEMO via ERROR_STATUS_MAP)
    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.code).toBe('MISSING_MEMO');

    // A FAILED payment sentinel is persisted so the tx hash is not retried
    expect(mockPaymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED', txHash: MEMO_HASH })
    );
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: Expired payment intent — rejected with INTENT_EXPIRED
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 6 — expired payment intent (recorded anyway)', () => {
  // #848: intents are a UX convenience; an expired intent must not block
  // crediting a payment that already settled on-chain. The intent is marked
  // expired for bookkeeping, but the payment is still recorded.
  test('verifyPayment records the payment and marks the intent expired without rejecting', async () => {
    mockVerifyTransaction.mockResolvedValueOnce(txResult({ hash: EXP_HASH }));
    mockIntentFindOne.mockResolvedValueOnce(freshIntent({
      expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
    }));

    const req  = makeReq({ txHash: EXP_HASH });
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.verified).toBe(true);
    expect(mockRecordPayment).toHaveBeenCalled();
    // The intent is still marked expired in the DB for bookkeeping.
    expect(mockIntentFindByIdUpdate).toHaveBeenCalledWith('intent001', { status: 'expired' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: Sync flow — payments matched, student feePaid updated
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 7 — sync flow', () => {
  test('syncAllPayments calls syncPaymentsForSchool and returns a summary with matched counts', async () => {
    const req  = {
      schoolId: SCHOOL_ID,
      school: { stellarAddress: WALLET_ADDR },
      auditContext: { performedBy: 'admin@school.edu', ipAddress: '127.0.0.1', userAgent: 'jest-e2e' },
    };
    const res  = makeRes();
    const next = jest.fn();

    await syncAllPayments(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockSyncPaymentsForSchool).toHaveBeenCalledWith(req.school);

    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe('Sync complete');
    expect(body.summary).toMatchObject({
      found: 1, new: 1, matched: 1, unmatched: 0, failed: 0,
    });
  });

  test('sync result with matched > 0 confirms student feePaid can be updated', async () => {
    // syncPaymentsForSchool is responsible for updating students internally;
    // here we assert that after a successful sync the service was invoked
    // with the school object and returned a positive matched count.
    mockSyncPaymentsForSchool.mockResolvedValueOnce({
      found: 3, new: 2, matched: 2, unmatched: 1, failed: 0, alreadyProcessed: 1, failedDetails: [],
    });

    const req  = {
      schoolId: SCHOOL_ID,
      school: { stellarAddress: WALLET_ADDR },
      auditContext: { performedBy: 'scheduler', ipAddress: '10.0.0.1', userAgent: 'cron' },
    };
    const res  = makeRes();
    const next = jest.fn();

    await syncAllPayments(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.summary.matched).toBe(2);
    expect(body.summary.new).toBe(2);
    // Student update is delegated to syncPaymentsForSchool — verify it was called
    expect(mockSyncPaymentsForSchool).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #582 — txHash presence validation
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E #582 — txHash presence validation in verifyPayment', () => {
  test.each([
    ['missing (undefined)',  {}],
    ['null',                 { txHash: null }],
    ['empty string',         { txHash: '' }],
  ])('returns 400 VALIDATION_ERROR when txHash is %s', async (_label, body) => {
    const req  = makeReq(body);
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const resp = res.json.mock.calls[0][0];
    expect(resp.code).toBe('VALIDATION_ERROR');
    expect(resp.error).toMatch(/txHash is required/i);
    // No Stellar network call should be made for an obviously invalid request
    expect(mockVerifyTransaction).not.toHaveBeenCalled();
  });

  test('audit log includes a meaningful targetId when txHash is missing', async () => {
    const { logAudit } = require('../backend/src/services/auditService');
    const req  = makeReq({});
    const res  = makeRes();
    const next = jest.fn();

    await verifyPayment(req, res, next);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: expect.stringContaining(SCHOOL_ID),
        result: 'failure',
      })
    );
  });
});
