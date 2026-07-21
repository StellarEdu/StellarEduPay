'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.MAX_QUEUE_DEPTH = '100';
process.env.QUEUE_BACKPRESSURE_HIGH_WATER = '80';
process.env.QUEUE_BACKPRESSURE_LOW_WATER = '40';
process.env.POLL_INTERVAL_MS = '30000';
process.env.JWT_SECRET = 'a'.repeat(32);

const mockTransactionsCall = jest.fn();
const mockLimit = jest.fn(() => ({ call: mockTransactionsCall }));
const mockAcquire = jest.fn(async () => ({ token: 'token', fencingToken: 1 }));
const mockRelease = jest.fn(async () => 1);
const mockFindOne = jest.fn(async () => null);
const mockAggregate = jest.fn(async () => []);
const mockStudentFindOne = jest.fn(async () => ({ studentId: 's1', schoolId: 'SCH001', feeAmount: 100, totalPaid: 0 }));
const mockStudentUpdate = jest.fn(async () => ({}));
const mockGetStats = jest.fn();

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
  connection: { startSession: jest.fn().mockResolvedValue({ withTransaction: async (cb) => cb(), endSession: async () => {} }) },
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({
          limit: mockLimit,
        }),
      }),
    }),
  },
}));

jest.mock('../src/models/schoolModel', () => ({
  find: jest.fn(),
}));

jest.mock('../src/models/paymentModel', () => ({
  findOne: (...args) => mockFindOne(...args),
  aggregate: (...args) => mockAggregate(...args),
  create: async () => ({}),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: (...args) => mockStudentFindOne(...args),
  findOneAndUpdate: (...args) => mockStudentUpdate(...args),
}));

jest.mock('../src/services/stellarService', () => ({
  extractValidPayment: jest.fn(async () => ({ payOp: { amount: '10', from: 'GABC' }, memo: 's1', asset: 'XLM' })),
  validatePaymentAgainstFee: jest.fn().mockReturnValue({ valid: true }),
  detectMemoCollision: jest.fn().mockResolvedValue({ suspicious: false, reason: null }),
  detectCrossSchoolMemoCollision: jest.fn().mockResolvedValue({ suspicious: false, reason: null }),
  detectAbnormalPatterns: jest.fn().mockResolvedValue({ suspicious: false, reason: null }),
  checkConfirmationStatus: jest.fn().mockResolvedValue(true),
  determineConfirmationState: jest.fn().mockResolvedValue({
    state: 'confirmed',
    changed: true,
    confirmationStatus: 'confirmed',
    latestLedgerSequence: 1,
  }),
}));

jest.mock('../src/services/sseService', () => ({ emit: jest.fn() }));
jest.mock('../src/utils/paymentLimits', () => ({ validatePaymentAmount: jest.fn().mockReturnValue({ valid: true }) }));
jest.mock('../src/utils/generateReferenceCode', () => ({ generateReferenceCode: jest.fn().mockResolvedValue('REF-TEST') }));
jest.mock('../src/services/currencyConversionService', () => ({ captureFiatSnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/services/distributedLock', () => ({ acquire: (...args) => mockAcquire(...args), release: (...args) => mockRelease(...args), getCurrentFence: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/services/concurrentPaymentProcessor', () => ({ concurrentPaymentProcessor: { getStats: () => mockGetStats() } }));
jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

const { pollSchoolTransactions } = require('../src/services/transactionPollingService');

const MOCK_SCHOOL = { schoolId: 'SCH001', stellarAddress: 'GTEST...', isActive: true };
const TX = { hash: 'TX1', created_at: '2026-06-18T00:00:00Z', ledger: 100, fee_paid: '100' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquire.mockResolvedValue({ token: 'token', fencingToken: 1 });
  mockLimit.mockReturnValue({ call: mockTransactionsCall });
  mockTransactionsCall.mockResolvedValue({ records: [TX] });
  mockGetStats.mockReturnValue({ queueDepth: 0, maxQueueDepth: 100 });
});

describe('transactionPollingService adaptive backpressure', () => {
  test('skips polling when processor queue exceeds high water mark', async () => {
    mockGetStats.mockReturnValue({ queueDepth: 85, maxQueueDepth: 100 });

    const result = await pollSchoolTransactions(MOCK_SCHOOL);

    expect(result.loadPaused).toBe(true);
    expect(result.processed).toBe(0);
    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test('reduces batch size as queue depth climbs toward high water', async () => {
    mockGetStats.mockReturnValue({ queueDepth: 70, maxQueueDepth: 100 });

    const result = await pollSchoolTransactions(MOCK_SCHOOL);

    expect(mockLimit).toHaveBeenCalledWith(5);
    expect(mockTransactionsCall).toHaveBeenCalled();
    expect(result.processed).toBe(1);
  });

  test('uses base batch size when queue depth is below low water', async () => {
    mockGetStats.mockReturnValue({ queueDepth: 20, maxQueueDepth: 100 });

    const result = await pollSchoolTransactions(MOCK_SCHOOL);

    expect(mockLimit).toHaveBeenCalledWith(20);
    expect(result.processed).toBe(1);
  });
});
