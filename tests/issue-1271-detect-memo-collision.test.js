'use strict';

/**
 * Tests for issue #1271 — duplicate $ne key in detectMemoCollision silently
 * dropped the sender comparison, turning a cross-sender collision detector into
 * a same-sender duplicate-payment detector.
 *
 * Root cause: the object literal
 *   { $ne: senderAddress, $exists: true, $ne: null }
 * is evaluated by JavaScript as
 *   { $exists: true, $ne: null }
 * because duplicate keys in an object literal keep only the last occurrence.
 * ESLint no-dupe-keys catches this, but the backend lint gate was never green
 * so the finding never blocked a merge.
 *
 * Fix: use $nin to express both exclusions in a single operator:
 *   { $nin: [senderAddress, null], $exists: true }
 *
 * Acceptance criteria (from the issue):
 *  1. Same memo + same sender inside the window → NOT flagged (instalment/retry).
 *  2. Same memo + different sender inside the window → flagged (collision).
 *  3. Same memo + different sender OUTSIDE the 24h window → NOT flagged.
 *  4. The query passed to Payment.findOne carries the senderAddress predicate
 *     so a future refactor cannot silently drop it.
 */

// ── Environment stubs ─────────────────────────────────────────────────────────
process.env.MONGO_URI             = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET            = 'test-secret-1271';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ── Mock Stellar SDK (virtual — package not installed at root) ─────────────────
jest.mock('@stellar/stellar-sdk', () => ({
  Operation: { _fromXDRAmount: (s) => (parseInt(s, 10) / 1e7).toFixed(7) },
  Horizon:   { Server: jest.fn().mockImplementation(() => ({})) },
  Networks:  { TESTNET: 'Test SDF Network ; September 2015' },
  Asset:     { native: jest.fn(() => ({ isNative: () => true })) },
}), { virtual: true });

// ── Mock paymentLimits (breaks systemConfigModel → mongoose chain) ─────────────
jest.mock('../backend/src/utils/paymentLimits', () => ({
  validatePaymentAmount: jest.fn().mockResolvedValue({ valid: true }),
}));

// ── Mock logger (breaks winston → winston-daily-rotate-file chain) ────────────
jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});

// ── Mock stellarConfig ─────────────────────────────────────────────────────────
jest.mock('../backend/src/config/stellarConfig', () => ({
  server:                 {},
  networkPassphrase:      'Test SDF Network ; September 2015',
  SCHOOL_WALLET:          null,
  ALL_ASSETS:             {},
  configuredAsset:        {},
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 5,
  isAcceptedAsset:        () => ({ accepted: true }),
}));

// ── Mock Mongoose models ───────────────────────────────────────────────────────
jest.mock('../backend/src/models/paymentModel', () => ({
  findOne:   jest.fn(),
  create:    jest.fn().mockResolvedValue({ toObject: () => ({}) }),
  exists:    jest.fn().mockResolvedValue(false),
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/models/studentModel', () => ({
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne:           jest.fn().mockResolvedValue(null),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/feeStructureModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/models/outboxModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create:  jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/sourceValidationRuleModel', () => ({
  find: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/services/transactionService', () => ({
  savePayment: jest.fn(),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────
const Payment                 = require('../backend/src/models/paymentModel');
const { detectMemoCollision } = require('../backend/src/services/stellarService');

// ── Shared fixtures ────────────────────────────────────────────────────────────
const SCHOOL_ID      = 'SCH-TEST';
const MEMO           = 'STU001';
const SENDER_A       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const SENDER_B       = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const TX_DATE        = new Date('2026-08-26T12:00:00Z');
const EXPECTED_FEE   = 250;
const PAYMENT_AMOUNT = 250;

beforeEach(() => {
  Payment.findOne.mockReset();
});

// ── 1. Same sender inside window — NOT flagged ────────────────────────────────

describe('same sender inside the 24h window (instalment / retry)', () => {
  it('returns suspicious: false — same-sender repeat payments are not collisions', async () => {
    // The $nin predicate correctly excludes same-sender documents; findOne returns null.
    Payment.findOne.mockResolvedValue(null);

    const result = await detectMemoCollision(
      MEMO, SENDER_A, PAYMENT_AMOUNT, EXPECTED_FEE, TX_DATE, SCHOOL_ID,
    );

    expect(result.suspicious).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('passes senderAddress in $nin so same-sender documents are excluded from the DB query', async () => {
    Payment.findOne.mockResolvedValue(null);

    await detectMemoCollision(
      MEMO, SENDER_A, PAYMENT_AMOUNT, EXPECTED_FEE, TX_DATE, SCHOOL_ID,
    );

    const query = Payment.findOne.mock.calls[0][0];

    // Structural assertion: the predicate must be $nin-based and contain the
    // caller's own address.  If a future edit reverts to a duplicate-$ne form
    // the test catches the regression because $nin won't be present.
    expect(query.senderAddress).toBeDefined();
    expect(query.senderAddress.$nin).toBeDefined();
    expect(query.senderAddress.$nin).toContain(SENDER_A);

    // null must also be excluded so sender-absent documents don't match.
    expect(query.senderAddress.$nin).toContain(null);
  });
});

// ── 2. Different sender inside window — flagged ───────────────────────────────

describe('different sender inside the 24h window (memo collision)', () => {
  it('returns suspicious: true and includes the memo and conflicting sender in the reason', async () => {
    // Simulate a prior payment from a different wallet that MongoDB returns.
    Payment.findOne.mockResolvedValue({ senderAddress: SENDER_B });

    const result = await detectMemoCollision(
      MEMO, SENDER_A, PAYMENT_AMOUNT, EXPECTED_FEE, TX_DATE, SCHOOL_ID,
    );

    expect(result.suspicious).toBe(true);
    expect(result.reason).toContain(MEMO);
    expect(result.reason).toContain(SENDER_B);
  });

  it('query is school-scoped, uses the correct memo, and bounds confirmedAt to the 24h window', async () => {
    Payment.findOne.mockResolvedValue({ senderAddress: SENDER_B });

    await detectMemoCollision(
      MEMO, SENDER_A, PAYMENT_AMOUNT, EXPECTED_FEE, TX_DATE, SCHOOL_ID,
    );

    const query       = Payment.findOne.mock.calls[0][0];
    const windowStart = query.confirmedAt.$gte;

    expect(query.schoolId).toBe(SCHOOL_ID);
    expect(query.memo).toBe(MEMO);
    expect(TX_DATE.getTime() - windowStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

// ── 3. Different sender outside window — NOT flagged ─────────────────────────

describe('different sender outside the 24h window', () => {
  it('returns suspicious: false — old cross-sender payments are not flagged', async () => {
    // MongoDB won't return the older payment because it falls before windowStart.
    Payment.findOne.mockResolvedValue(null);

    const result = await detectMemoCollision(
      MEMO, SENDER_A, PAYMENT_AMOUNT, EXPECTED_FEE, TX_DATE, SCHOOL_ID,
    );

    expect(result.suspicious).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('window boundary correctly excludes a payment confirmed 25h before txDate', async () => {
    Payment.findOne.mockResolvedValue(null);

    await detectMemoCollision(
      MEMO, SENDER_A, PAYMENT_AMOUNT, EXPECTED_FEE, TX_DATE, SCHOOL_ID,
    );

    const query        = Payment.findOne.mock.calls[0][0];
    const windowStart  = query.confirmedAt.$gte;

    // A payment confirmed 25 h before txDate is before windowStart (txDate − 24 h),
    // so MongoDB's $gte correctly excludes it.
    const twentyFiveHoursAgo = new Date(TX_DATE.getTime() - 25 * 60 * 60 * 1000);
    expect(twentyFiveHoursAgo.getTime()).toBeLessThan(windowStart.getTime());
  });
});
