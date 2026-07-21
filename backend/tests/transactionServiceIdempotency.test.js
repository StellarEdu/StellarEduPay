'use strict';

/**
 * Race / idempotency tests for transactionService.savePayment (#847).
 *
 * Verifies that the DB unique-index strategy (not a pre-check findOne) is the
 * sole guard against duplicate payment records, and that concurrent callers
 * racing on the same txHash each get the right outcome: one winner, one
 * DUPLICATE_TX error.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

jest.mock('../src/events/paymentEvents', () => ({
  emit: jest.fn(),
}));

jest.mock('../src/utils/generateReferenceCode', () => ({
  generateReferenceCode: jest.fn().mockResolvedValue('REF-001'),
}));

const mockCreate = jest.fn();
jest.mock('../src/models/paymentModel', () => ({
  create: (...args) => mockCreate(...args),
}));

// savePayment now writes a "payment.saved" event to the outbox (real mongoose
// model) instead of emitting synchronously — mock it so it doesn't hit a DB.
const mockOutboxCreate = jest.fn().mockResolvedValue({});
jest.mock('../src/models/outboxModel', () => ({
  create: (...args) => mockOutboxCreate(...args),
}));

const paymentEvents = require('../src/events/paymentEvents');

beforeEach(() => {
  jest.clearAllMocks();
});

function freshService() {
  jest.resetModules();
  // Re-apply mocks after module reset so the fresh require picks them up.
  jest.mock('../src/utils/logger', () => ({
    child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  }));
  jest.mock('../src/events/paymentEvents', () => ({ emit: jest.fn() }));
  jest.mock('../src/utils/generateReferenceCode', () => ({
    generateReferenceCode: jest.fn().mockResolvedValue('REF-001'),
  }));
  jest.mock('../src/models/paymentModel', () => ({
    create: (...args) => mockCreate(...args),
  }));
  jest.mock('../src/models/outboxModel', () => ({
    create: (...args) => mockOutboxCreate(...args),
  }));
  return require('../src/services/transactionService');
}

const BASE_DATA = {
  schoolId: 'SCH-1',
  studentId: 'STU-001',
  txHash: 'abc123hash',
  amount: 100,
  status: 'SUCCESS',
};

describe('savePayment — happy path', () => {
  it('creates the payment and writes a payment.saved outbox event', async () => {
    const saved = { ...BASE_DATA, _id: 'doc1', toObject() { return this; } };
    mockCreate.mockResolvedValueOnce(saved);

    const { savePayment } = require('../src/services/transactionService');
    const result = await savePayment(BASE_DATA);

    expect(result).toBe(saved);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'payment.saved', aggregateId: BASE_DATA.txHash }),
      expect.anything()
    );
  });
});

describe('savePayment — duplicate key (DB unique index)', () => {
  it('throws DUPLICATE_TX when Payment.create rejects with code 11000', async () => {
    const dupErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    mockCreate.mockRejectedValueOnce(dupErr);

    const { savePayment } = require('../src/services/transactionService');
    const err = await savePayment(BASE_DATA).catch(e => e);

    expect(err.code).toBe('DUPLICATE_TX');
    expect(err.message).toContain(BASE_DATA.txHash);
  });

  it('does NOT call Payment.create a second time (no retry on duplicate)', async () => {
    const dupErr = Object.assign(new Error('E11000'), { code: 11000 });
    mockCreate.mockRejectedValueOnce(dupErr);

    const { savePayment } = require('../src/services/transactionService');
    await savePayment(BASE_DATA).catch(() => {});

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-duplicate errors unchanged', async () => {
    const unexpected = new Error('network timeout');
    mockCreate.mockRejectedValueOnce(unexpected);

    const { savePayment } = require('../src/services/transactionService');
    const err = await savePayment(BASE_DATA).catch(e => e);

    expect(err).toBe(unexpected);
    expect(err.code).toBeUndefined();
  });
});

describe('savePayment — concurrent race (same txHash, same schoolId)', () => {
  it('one call wins, the other gets DUPLICATE_TX — exactly one record created', async () => {
    const saved = { ...BASE_DATA, _id: 'doc1', toObject() { return this; } };
    const dupErr = Object.assign(new Error('E11000'), { code: 11000 });

    // Simulate two concurrent inserts: first resolves, second hits the unique index.
    mockCreate
      .mockResolvedValueOnce(saved)
      .mockRejectedValueOnce(dupErr);

    const { savePayment } = require('../src/services/transactionService');
    const [r1, r2] = await Promise.allSettled([
      savePayment(BASE_DATA),
      savePayment(BASE_DATA),
    ]);

    const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected  = [r1, r2].filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0].value).toBe(saved);
    expect(rejected[0].reason.code).toBe('DUPLICATE_TX');

    // DB was hit exactly twice (no extra retries or pre-check queries).
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('both concurrent calls getting 11000 both throw DUPLICATE_TX', async () => {
    const dupErr = Object.assign(new Error('E11000'), { code: 11000 });
    mockCreate
      .mockRejectedValueOnce(dupErr)
      .mockRejectedValueOnce(dupErr);

    const { savePayment } = require('../src/services/transactionService');
    const [r1, r2] = await Promise.allSettled([
      savePayment(BASE_DATA),
      savePayment(BASE_DATA),
    ]);

    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(r1.reason.code).toBe('DUPLICATE_TX');
    expect(r2.reason.code).toBe('DUPLICATE_TX');
  });
});
