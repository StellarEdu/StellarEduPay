'use strict';

/**
 * Tests for issue #1798 — creditable school-wallet payments with an unknown or
 * mistyped memo were dropped after a log line. They must be persisted to an
 * unmatched-payments queue.
 *
 * Acceptance criteria:
 * - A creditable inflow that cannot be attributed is stored as an open record
 * - Recording the same { schoolId, txHash, opIndex } twice creates one record
 * - Both the poller and the manual sync write to the queue
 */

jest.mock('../backend/src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('../backend/src/models/unmatchedPaymentModel', () => {
  const model = {
    updateOne: jest.fn(),
    find: jest.fn(),
  };
  return model;
});

const fs = require('fs');
const path = require('path');
const UnmatchedPayment = require('../backend/src/models/unmatchedPaymentModel');
const { recordUnmatchedPayment, listUnmatchedPayments } = require('../backend/src/services/unmatchedPaymentService');

const tx = { hash: 'abc123', ledger_attr: 4242 };
const payOp = { amount: '150.0000000', asset_type: 'native', from: 'GSENDER', to: 'GSCHOOL' };

describe('Issue #1798 — recordUnmatchedPayment', () => {
  beforeEach(() => {
    UnmatchedPayment.updateOne.mockResolvedValue({ upsertedCount: 1 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('stores an open record keyed by school, transaction and operation', async () => {
    const result = await recordUnmatchedPayment({
      schoolId: 'school-1',
      tx,
      payOp,
      memo: 'STU-99',
      memoType: 'text',
      asset: null,
      reason: 'student_not_found',
    });

    expect(result).toEqual({ recorded: true });
    const [filter, update, options] = UnmatchedPayment.updateOne.mock.calls[0];
    expect(filter).toEqual({ schoolId: 'school-1', txHash: 'abc123', opIndex: 0 });
    expect(options).toEqual({ upsert: true });
    expect(update.$setOnInsert).toMatchObject({
      amount: '150.0000000',
      assetCode: 'XLM',
      memo: 'STU-99',
      memoType: 'text',
      senderAddress: 'GSENDER',
      ledger: 4242,
      reason: 'student_not_found',
      status: 'open',
    });
  });

  test('does not put key fields in $setOnInsert (avoids a path conflict with the filter)', async () => {
    await recordUnmatchedPayment({ schoolId: 's', tx, payOp, memo: null, reason: 'student_not_found' });
    const [, update] = UnmatchedPayment.updateOne.mock.calls[0];
    expect(update.$setOnInsert).not.toHaveProperty('schoolId');
    expect(update.$setOnInsert).not.toHaveProperty('txHash');
    expect(update.$setOnInsert).not.toHaveProperty('opIndex');
  });

  test('a repeated record for the same transaction is a no-op, not an error', async () => {
    UnmatchedPayment.updateOne.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

    await expect(
      recordUnmatchedPayment({ schoolId: 's', tx, payOp, memo: 'X', reason: 'student_not_found' })
    ).resolves.toEqual({ recorded: false });
  });

  test('other storage failures are rethrown so the caller does not advance its cursor', async () => {
    UnmatchedPayment.updateOne.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      recordUnmatchedPayment({ schoolId: 's', tx, payOp, memo: 'X', reason: 'student_not_found' })
    ).rejects.toThrow('connection lost');
  });

  test('uses the asset code for issued assets', async () => {
    await recordUnmatchedPayment({
      schoolId: 's',
      tx,
      payOp: { amount: '5', asset_type: 'credit_alphanum4', asset_code: 'USDC', from: 'G' },
      memo: null,
      reason: 'student_not_found',
    });
    const [, update] = UnmatchedPayment.updateOne.mock.calls[0];
    expect(update.$setOnInsert.assetCode).toBe('USDC');
  });
});

describe('Issue #1798 — listUnmatchedPayments', () => {
  test('filters by school and status, newest first, with a capped limit', async () => {
    const lean = jest.fn().mockResolvedValue([{ txHash: 'abc123' }]);
    const limit = jest.fn(() => ({ lean }));
    const sort = jest.fn(() => ({ limit }));
    UnmatchedPayment.find.mockReturnValue({ sort });

    const rows = await listUnmatchedPayments('school-1', { limit: 10000 });

    expect(UnmatchedPayment.find).toHaveBeenCalledWith({ schoolId: 'school-1', status: 'open' });
    expect(sort).toHaveBeenCalledWith({ receivedAt: -1 });
    expect(limit).toHaveBeenCalledWith(500);
    expect(rows).toEqual([{ txHash: 'abc123' }]);
  });
});

describe('Issue #1798 — schema', () => {
  test('a unique index covers { schoolId, txHash, opIndex }', () => {
    const realModel = jest.requireActual('../backend/src/models/unmatchedPaymentModel');
    const indexes = realModel.schema.indexes();
    const unique = indexes.find(([fields, opts]) =>
      opts && opts.unique && fields.schoolId === 1 && fields.txHash === 1 && fields.opIndex === 1
    );
    expect(unique).toBeDefined();
  });

  test('status is limited to open, matched, refunded and ignored', () => {
    const realModel = jest.requireActual('../backend/src/models/unmatchedPaymentModel');
    expect(realModel.UNMATCHED_STATUSES).toEqual(['open', 'matched', 'refunded', 'ignored']);
  });
});

describe('Issue #1798 — both payment pipelines write to the queue', () => {
  test('the poller records student_not_found inflows', () => {
    const src = fs.readFileSync(path.join(__dirname, '../backend/src/services/transactionPollingService.js'), 'utf8');
    expect(src).toMatch(/recordUnmatchedPayment\(\{[^}]*reason: 'student_not_found'/);
  });

  test('the manual sync records unmatched inflows before skipping them', () => {
    const src = fs.readFileSync(path.join(__dirname, '../backend/src/services/stellarService.js'), 'utf8');
    expect(src).toMatch(/await recordUnmatchedPayment\(\{[^}]*\}\);\s*summary\.unmatched\+\+;/);
  });
});
