'use strict';

/**
 * Tests for issue #747's two explicitly requested scenarios that the pure
 * state-machine unit tests (paymentConfirmationStateMachine.test.js) can't
 * cover on their own, because they involve stellarService's Horizon/DB
 * integration:
 *
 *   1. Re-polling the same tx (same Horizon ledger range) never advances a
 *      payment's confirmationState incorrectly.
 *   2. Memo collision detection across schools (detectCrossSchoolMemoCollision).
 */

jest.mock('../src/config/index', () => ({
  MONGO_URI: 'mongodb://localhost/test',
  PORT: 5000,
  STELLAR_NETWORK: 'testnet',
  IS_TESTNET: true,
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_TIMEOUT_MS: 3000,
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 10,
  // paymentLimits.js (loaded transitively via stellarService) builds Decimals
  // from these at module load — omitting them throws [DecimalError] undefined.
  MIN_PAYMENT_AMOUNT: 0.01,
  MAX_PAYMENT_AMOUNT: 100000,
}));

const mockLedgerCall = jest.fn();
jest.mock('../src/config/stellarConfig', () => ({
  server: {
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: (...args) => mockLedgerCall(...args),
        }),
      }),
    }),
  },
  networkPassphrase: 'Test SDF Network ; September 2015',
  isAcceptedAsset: () => ({ accepted: true }),
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 10,
}));

jest.mock('../src/models/paymentModel');
jest.mock('../src/models/studentModel');
jest.mock('../src/models/paymentIntentModel');
jest.mock('../src/services/transactionService', () => ({ savePayment: jest.fn() }));

const Payment = require('../src/models/paymentModel');
const {
  determineConfirmationState,
  detectCrossSchoolMemoCollision,
} = require('../src/services/stellarService');
const { CONFIRMATION_STATES } = require('../src/services/paymentConfirmationStateMachine');

function setLatestLedger(sequence) {
  mockLedgerCall.mockResolvedValue({ records: [{ sequence }] });
}

describe('determineConfirmationState — re-poll idempotency', () => {
  const TX_LEDGER = 1000;

  beforeEach(() => {
    mockLedgerCall.mockReset();
  });

  it('re-polling the same ledger range (latest unchanged) never advances the state again', async () => {
    setLatestLedger(1002); // depth 2 -> confirmed (threshold 2)

    const first = await determineConfirmationState(TX_LEDGER, CONFIRMATION_STATES.DETECTED, false);
    expect(first.state).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(first.changed).toBe(true);

    // Simulate re-polling the exact same tx in a later cycle where Horizon
    // reports the same latest ledger (e.g. the poll loop re-ran before a new
    // ledger closed). The payment is already 'confirmed' going in.
    const second = await determineConfirmationState(TX_LEDGER, first.state, false);
    expect(second.state).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(second.changed).toBe(false);

    const third = await determineConfirmationState(TX_LEDGER, second.state, false);
    expect(third.state).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(third.changed).toBe(false);
  });

  it('does not regress if Horizon briefly reports a lower (stale/failover) ledger on re-poll', async () => {
    setLatestLedger(1005); // depth 5 -> confirmed
    const confirmed = await determineConfirmationState(TX_LEDGER, CONFIRMATION_STATES.DETECTED, false);
    expect(confirmed.state).toBe(CONFIRMATION_STATES.CONFIRMED);

    // A failover/replica lag momentarily reports an earlier ledger.
    setLatestLedger(1001); // depth 1 -> would compute as 'pending'
    const repoll = await determineConfirmationState(TX_LEDGER, confirmed.state, false);
    expect(repoll.state).toBe(CONFIRMATION_STATES.CONFIRMED);
    expect(repoll.changed).toBe(false);
  });

  it('still advances forward correctly once enough additional ledgers close', async () => {
    setLatestLedger(1002); // depth 2 -> confirmed
    const confirmed = await determineConfirmationState(TX_LEDGER, CONFIRMATION_STATES.DETECTED, false);
    expect(confirmed.state).toBe(CONFIRMATION_STATES.CONFIRMED);

    setLatestLedger(1010); // depth 10 -> finalized
    const finalized = await determineConfirmationState(TX_LEDGER, confirmed.state, false);
    expect(finalized.state).toBe(CONFIRMATION_STATES.FINALIZED);
    expect(finalized.changed).toBe(true);

    // Further re-polls after finalization are permanently no-ops.
    setLatestLedger(1050);
    const repoll = await determineConfirmationState(TX_LEDGER, finalized.state, false);
    expect(repoll.state).toBe(CONFIRMATION_STATES.FINALIZED);
    expect(repoll.changed).toBe(false);
  });

  it('routes to failed when isSuspicious is true, and re-polling keeps it failed', async () => {
    setLatestLedger(1002);
    const failed = await determineConfirmationState(TX_LEDGER, CONFIRMATION_STATES.PENDING, true);
    expect(failed.state).toBe(CONFIRMATION_STATES.FAILED);
    expect(failed.confirmationStatus).toBe('failed');

    setLatestLedger(1020);
    const repoll = await determineConfirmationState(TX_LEDGER, failed.state, false);
    expect(repoll.state).toBe(CONFIRMATION_STATES.FAILED);
    expect(repoll.changed).toBe(false);
  });
});

describe('detectCrossSchoolMemoCollision', () => {
  const schoolId = 'SCH-A';
  const memo = 'STU001';
  const txDate = new Date('2026-06-21T12:00:00Z');

  beforeEach(() => {
    Payment.findOne.mockReset();
  });

  it('flags a collision when the same memo was paid to a different school within 24h', async () => {
    Payment.findOne.mockResolvedValue({ schoolId: 'SCH-B' });

    const result = await detectCrossSchoolMemoCollision(memo, schoolId, txDate);

    expect(result.suspicious).toBe(true);
    expect(result.reason).toContain(memo);
    expect(result.reason).toContain('SCH-B');
    expect(Payment.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: { $ne: schoolId },
        studentId: memo,
      }),
    );
  });

  it('does not flag when no other school used the memo recently', async () => {
    Payment.findOne.mockResolvedValue(null);

    const result = await detectCrossSchoolMemoCollision(memo, schoolId, txDate);

    expect(result.suspicious).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('scopes the lookup to the trailing 24h window', async () => {
    Payment.findOne.mockResolvedValue(null);

    await detectCrossSchoolMemoCollision(memo, schoolId, txDate);

    const queryArg = Payment.findOne.mock.calls[0][0];
    const windowStart = queryArg.confirmedAt.$gte;
    expect(txDate.getTime() - windowStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
