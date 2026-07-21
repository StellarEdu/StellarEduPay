'use strict';

const { checkConsistency } = require('../backend/src/services/consistencyService');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockOperations = jest.fn();

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({
      forAccount: (wallet) => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: mockChainTxsByWallet[wallet] || [] }),
          }),
        }),
      }),
    }),
  },
}));

const mockFind = jest.fn();
jest.mock('../backend/src/models/paymentModel', () => ({
  find: (...args) => ({ lean: () => mockFind(...args) }),
}));

const mockSchoolFind = jest.fn();
jest.mock('../backend/src/models/schoolModel', () => ({
  find: () => ({ lean: () => mockSchoolFind() }),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  find: () => ({ lean: () => Promise.resolve([]) }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

// Shared mutable state
let mockChainTxsByWallet = {};

function makeChainTx(hash, memo, amount, toWallet) {
  return {
    hash,
    memo,
    successful: true,
    operations: async () => ({
      records: [{ type: 'payment', to: toWallet, amount: String(amount) }],
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockChainTxsByWallet = {};
  mockFind.mockReset();
  mockSchoolFind.mockReset();
});

describe('checkConsistency — multi-school', () => {
  test('checks each school wallet independently', async () => {
    mockSchoolFind.mockResolvedValue([
      { schoolId: 'SCH-A', stellarAddress: 'GWALLET_A' },
      { schoolId: 'SCH-B', stellarAddress: 'GWALLET_B' },
    ]);

    mockChainTxsByWallet['GWALLET_A'] = [makeChainTx('hashA1', 'STU001', 250, 'GWALLET_A')];
    mockChainTxsByWallet['GWALLET_B'] = [makeChainTx('hashB1', 'STU002', 300, 'GWALLET_B')];

    mockFind.mockImplementation(({ schoolId }) => {
      if (schoolId === 'SCH-A') return Promise.resolve([{ txHash: 'hashA1', studentId: 'STU001', amount: 250 }]);
      if (schoolId === 'SCH-B') return Promise.resolve([{ txHash: 'hashB1', studentId: 'STU002', amount: 300 }]);
      return Promise.resolve([]);
    });

    const report = await checkConsistency();

    expect(report.schoolsChecked).toBe(2);
    expect(report.mismatchCount).toBe(0);
    expect(report.bySchool).toHaveLength(2);
    expect(report.bySchool.map((s) => s.schoolId)).toEqual(
      expect.arrayContaining(['SCH-A', 'SCH-B'])
    );
  });

  test('does not cross-contaminate payments between schools', async () => {
    mockSchoolFind.mockResolvedValue([
      { schoolId: 'SCH-A', stellarAddress: 'GWALLET_A' },
      { schoolId: 'SCH-B', stellarAddress: 'GWALLET_B' },
    ]);

    // SCH-A has a payment that is NOT on GWALLET_B's chain
    mockChainTxsByWallet['GWALLET_A'] = [makeChainTx('hashA1', 'STU001', 250, 'GWALLET_A')];
    mockChainTxsByWallet['GWALLET_B'] = [];

    mockFind.mockImplementation(({ schoolId }) => {
      if (schoolId === 'SCH-A') return Promise.resolve([{ txHash: 'hashA1', studentId: 'STU001', amount: 250 }]);
      if (schoolId === 'SCH-B') return Promise.resolve([]); // no payments for SCH-B
      return Promise.resolve([]);
    });

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(0);
    const schA = report.bySchool.find((s) => s.schoolId === 'SCH-A');
    const schB = report.bySchool.find((s) => s.schoolId === 'SCH-B');
    expect(schA.mismatchCount).toBe(0);
    expect(schB.mismatchCount).toBe(0);
  });

  test('flags missing_on_chain per school', async () => {
    mockSchoolFind.mockResolvedValue([
      { schoolId: 'SCH-A', stellarAddress: 'GWALLET_A' },
    ]);
    mockChainTxsByWallet['GWALLET_A'] = [];
    mockFind.mockResolvedValue([{ txHash: 'ghost', studentId: 'STU001', amount: 100 }]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].type).toBe('missing_on_chain');
  });

  test('returns empty report when no active schools', async () => {
    mockSchoolFind.mockResolvedValue([]);

    const report = await checkConsistency();

    expect(report.schoolsChecked).toBe(0);
    expect(report.mismatchCount).toBe(0);
    expect(report.totalDbPayments).toBe(0);
  });

  test('report includes checkedAt timestamp', async () => {
    mockSchoolFind.mockResolvedValue([]);

    const report = await checkConsistency();

    expect(report.checkedAt).toBeDefined();
    expect(new Date(report.checkedAt).toString()).not.toBe('Invalid Date');
  });
});

// ─── Backward-compatible single-school tests ──────────────────────────────────

describe('checkConsistency — single school (backward compat)', () => {
  function setup(wallet, chainTxs, dbPayments) {
    mockSchoolFind.mockResolvedValue([{ schoolId: 'SCH-DEFAULT', stellarAddress: wallet }]);
    mockChainTxsByWallet[wallet] = chainTxs;
    mockFind.mockResolvedValue(dbPayments);
  }

  test('returns clean report when DB and chain match', async () => {
    setup('GSCHOOL123', [makeChainTx('hash1', 'STU001', 250, 'GSCHOOL123')], [
      { txHash: 'hash1', studentId: 'STU001', amount: 250 },
    ]);

    const report = await checkConsistency();
    expect(report.mismatchCount).toBe(0);
    expect(report.totalDbPayments).toBe(1);
  });

  test('flags amount_mismatch', async () => {
    setup('GSCHOOL123', [makeChainTx('hash2', 'STU003', 300, 'GSCHOOL123')], [
      { txHash: 'hash2', studentId: 'STU003', amount: 150 },
    ]);

    const report = await checkConsistency();
    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].type).toBe('amount_mismatch');
  });

  test('flags student_mismatch', async () => {
    setup('GSCHOOL123', [makeChainTx('hash3', 'STU999', 200, 'GSCHOOL123')], [
      { txHash: 'hash3', studentId: 'STU001', amount: 200 },
    ]);

    const report = await checkConsistency();
    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].type).toBe('student_mismatch');
  });
});

// ─── Scheduler tests ──────────────────────────────────────────────────────────

describe('consistencyScheduler', () => {
  let startConsistencyScheduler, stopConsistencyScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();

    jest.mock('../backend/src/services/consistencyService', () => ({
      checkConsistency: jest.fn().mockResolvedValue({
        checkedAt: new Date().toISOString(),
        schoolsChecked: 1,
        totalDbPayments: 0,
        totalChainTxsScanned: 0,
        mismatchCount: 0,
        mismatches: [],
        bySchool: [],
      }),
    }));

    // Scheduler calls School.countDocuments before checkConsistency
    jest.mock('../backend/src/models/schoolModel', () => ({
      countDocuments: jest.fn().mockResolvedValue(1),
    }));

    ({ startConsistencyScheduler, stopConsistencyScheduler } =
      require('../backend/src/services/consistencyScheduler'));
  });

  afterEach(() => {
    stopConsistencyScheduler();
    jest.useRealTimers();
  });

  test('runs an immediate check on start', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    startConsistencyScheduler();
    await Promise.resolve();
    await Promise.resolve(); // flush School.countDocuments microtask
    expect(checkConsistency).toHaveBeenCalledTimes(1);
  });

  test('runs again after the interval elapses', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    startConsistencyScheduler();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(checkConsistency).toHaveBeenCalledTimes(2);
  });

  test('stop prevents further checks', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    startConsistencyScheduler();
    await Promise.resolve();
    await Promise.resolve();
    stopConsistencyScheduler();
    jest.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(checkConsistency).toHaveBeenCalledTimes(1);
  });

  test('logs a warning when mismatches are found', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    checkConsistency.mockResolvedValueOnce({
      checkedAt: new Date().toISOString(),
      schoolsChecked: 1,
      totalDbPayments: 1,
      totalChainTxsScanned: 0,
      mismatchCount: 1,
      mismatches: [{ type: 'missing_on_chain', message: 'tx ghost not found on-chain' }],
      bySchool: [],
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    startConsistencyScheduler();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 mismatch(es) detected'));
    warnSpy.mockRestore();
  });
});
