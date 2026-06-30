'use strict';

/**
 * #839 — Horizon cursor management & pagination correctness for the poller.
 *
 * Asserts the poller:
 *   - resumes ASCENDING paging from the persisted per-school cursor,
 *   - persists the advancing cursor (last examined paging_token) each cycle,
 *   - never re-scans from genesis once a cursor exists (no full rescans),
 *   - processes every record in a page in order (gap-free), and
 *   - on a Horizon 429 surfaces a horizonError WITHOUT advancing the cursor,
 *     so the next cycle resumes safely (and the cycle backs off).
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.POLL_INTERVAL_MS = '30000';

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
  connection: { startSession: jest.fn() },
}));

// Configurable Horizon server mock that records each call's order + cursor and
// returns queued pages. (`mock`-prefixed so jest.mock may reference them.)
const mockCallLog = [];
let mockPageQueue = [];
let mockFailNext = null; // error to throw on next call, or null

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({
      forAccount: () => {
        const state = {};
        const builder = {
          order: (o) => { state.order = o; return builder; },
          limit: (n) => { state.limit = n; return builder; },
          cursor: (c) => { state.cursor = c; return builder; },
          call: async () => {
            mockCallLog.push({ order: state.order, cursor: state.cursor, limit: state.limit });
            if (mockFailNext) { const e = mockFailNext; mockFailNext = null; throw e; }
            return mockPageQueue.shift() || { records: [] };
          },
        };
        return builder;
      },
    }),
  },
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  find: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
}));
jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  aggregate: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/services/stellarService', () => ({
  extractValidPayment: jest.fn().mockResolvedValue(null), // skip path — exercises cursor only
  validatePaymentAgainstFee: jest.fn().mockReturnValue({ status: 'valid' }),
  detectMemoCollision: jest.fn().mockResolvedValue({ suspicious: false }),
  detectCrossSchoolMemoCollision: jest.fn().mockResolvedValue({ suspicious: false }),
  detectAbnormalPatterns: jest.fn().mockResolvedValue({ suspicious: false }),
  checkConfirmationStatus: jest.fn().mockResolvedValue(true),
  determineConfirmationState: jest.fn().mockResolvedValue({
    state: 'confirmed', changed: true, confirmationStatus: 'confirmed', latestLedgerSequence: 1,
  }),
}));
jest.mock('../backend/src/services/sseService', () => ({ emit: jest.fn() }));
jest.mock('../backend/src/services/distributedLock', () => ({
  acquire: jest.fn().mockResolvedValue('lock-token'),
  release: jest.fn().mockResolvedValue(true),
}));
jest.mock('../backend/src/utils/paymentLimits', () => ({
  validatePaymentAmount: jest.fn().mockReturnValue({ valid: true }),
}));
jest.mock('../backend/src/utils/generateReferenceCode', () => ({
  generateReferenceCode: jest.fn().mockResolvedValue('REF001'),
}));
jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const School = require('../backend/src/models/schoolModel');
const lock = require('../backend/src/services/distributedLock');
const {
  pollSchoolTransactions,
  pollAllSchools,
  _getBackoffState,
  _resetBackoffState,
} = require('../backend/src/services/transactionPollingService');

const ADDRESS = 'GTEST_WALLET_ADDRESS';
const rec = (token) => ({ hash: `tx_${token}`, paging_token: token, created_at: '2026-01-01T00:00:00Z' });

beforeEach(() => {
  _resetBackoffState();
  jest.clearAllMocks();
  mockCallLog.length = 0;
  mockPageQueue = [];
  mockFailNext = null;
  lock.acquire.mockResolvedValue('lock-token');
});

describe('poller cursor management (#839)', () => {
  test('first run (no cursor) pages ascending from the oldest and persists the last token', async () => {
    mockPageQueue = [{ records: [rec('1'), rec('2'), rec('3')] }];
    const school = { schoolId: 'SCH001', stellarAddress: ADDRESS };

    const result = await pollSchoolTransactions(school);

    // Ascending order, no cursor passed on the first-ever call.
    expect(mockCallLog[0].order).toBe('asc');
    expect(mockCallLog[0].cursor).toBeUndefined();
    // Every record examined (gap-free); cursor advanced to the last token.
    expect(result.skipped).toBe(3);
    expect(result.cursor).toBe('3');
    expect(School.updateOne).toHaveBeenCalledWith(
      { schoolId: 'SCH001' },
      { $set: { syncCursor: '3' } },
    );
  });

  test('resumes from the persisted cursor — no full-history rescan', async () => {
    mockPageQueue = [{ records: [rec('11'), rec('12')] }];
    const school = { schoolId: 'SCH001', stellarAddress: ADDRESS, syncCursor: '10' };

    await pollSchoolTransactions(school);

    expect(mockCallLog[0].cursor).toBe('10'); // resumed, not from genesis
    expect(mockCallLog[0].order).toBe('asc');
    expect(School.updateOne).toHaveBeenCalledWith(
      { schoolId: 'SCH001' },
      { $set: { syncCursor: '12' } },
    );
  });

  test('drains multiple pages within a cycle until a short page is returned', async () => {
    // A full page (== limit) forces another fetch; the short page ends the cycle.
    const full = Array.from({ length: 20 }, (_, i) => rec(`p1_${i}`));
    mockPageQueue = [{ records: full }, { records: [rec('p2_0')] }];
    const school = { schoolId: 'SCH001', stellarAddress: ADDRESS };

    const result = await pollSchoolTransactions(school);

    expect(mockCallLog.length).toBe(2);
    expect(mockCallLog[1].cursor).toBe('p1_19'); // second fetch resumes after the full page
    expect(result.cursor).toBe('p2_0');
  });

  test('a 429 surfaces horizonError and does NOT advance the cursor', async () => {
    mockFailNext = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const school = { schoolId: 'SCH001', stellarAddress: ADDRESS, syncCursor: '5' };

    const result = await pollSchoolTransactions(school);

    expect(result.horizonError).toBe(true);
    expect(result.status).toBe(429);
    expect(School.updateOne).not.toHaveBeenCalled(); // cursor untouched → safe resume
    expect(lock.release).toHaveBeenCalled();         // lock always released
  });

  test('a 429 in a cycle triggers exponential backoff', async () => {
    School.find.mockResolvedValue([{ schoolId: 'SCH001', stellarAddress: ADDRESS }]);
    mockFailNext = Object.assign(new Error('Too Many Requests'), { status: 429 });

    await pollAllSchools();

    const { consecutiveErrors, currentIntervalMs } = _getBackoffState();
    expect(consecutiveErrors).toBe(1);
    expect(currentIntervalMs).toBe(30000 * 2);
  });

  test('lock contention skips the school without touching the cursor', async () => {
    lock.acquire.mockResolvedValueOnce(null);
    const school = { schoolId: 'SCH001', stellarAddress: ADDRESS, syncCursor: '5' };

    const result = await pollSchoolTransactions(school);

    expect(result.lockSkipped).toBe(true);
    expect(mockCallLog.length).toBe(0);
    expect(School.updateOne).not.toHaveBeenCalled();
  });
});
