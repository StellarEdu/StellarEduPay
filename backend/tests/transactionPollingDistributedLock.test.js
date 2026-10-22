'use strict';

/**
 * Integration tests for distributed-lock-protected transaction polling.
 *
 * Goals (acceptance criteria):
 *   1. Two replicas polling the same school never create duplicate Payment docs.
 *   2. A duplicate insert is rejected atomically by the unique index
 *      ({ schoolId, txHash }) — proven by bypassing the read pre-check so both
 *      workers reach create() and only one succeeds.
 *   3. The poll interval is driven by config.SYNC_INTERVAL_MS (env), not a
 *      hardcoded constant, and SYNC_INTERVAL_MS=0 disables polling.
 *
 * ioredis is mocked with a single shared key store so two isolated module loads
 * of the service contend over the same `SET NX PX` lock, simulating replicas.
 * The persistence layer is mocked with a shared in-memory store whose create()
 * enforces { schoolId, txHash } uniqueness (the unique index) by throwing 11000.
 */

// ── Shared mock state (mock-prefixed so jest.mock factories may reference it) ──
const mockRedisStore = new Map();

const mockPayments = [];
const mockSeenKeys = new Set(); // `${schoolId}|${txHash}` — the unique index
let mockFindOneImpl = async () => null;
let mockTxRecords = [];
const mockSchoolFind = jest.fn(async () => [
  { schoolId: 'school-1', stellarAddress: 'GABC', isActive: true },
]);

// ── ioredis: shared SET NX PX + Lua-release store ────────────────────────────
jest.mock('ioredis', () => {
  const NodeEventEmitter = require('events');
  return class MockRedis extends NodeEventEmitter {
    connect() { return Promise.resolve(); }
    async set(key, value, ...opts) {
      const nx = opts.includes('NX');
      const pxIdx = opts.indexOf('PX');
      const ttl = pxIdx >= 0 ? Number(opts[pxIdx + 1]) : null;
      const existing = mockRedisStore.get(key);
      const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
      if (nx && alive) return null;
      mockRedisStore.set(key, { value, expiresAt: ttl != null ? Date.now() + ttl : null });
      return 'OK';
    }
    async eval(script, numKeys, ...args) {
      const key = args[0];

      // Fence acquisition script
      if (script && script.includes('incr') && numKeys === 2 && args.length >= 4) {
        const fenceKey = args[1];
        const token = args[2];
        const ttl = args[3];

        const existing = mockRedisStore.get(key);
        const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
        if (alive && existing.value) return null;

        const existingFence = mockRedisStore.get(fenceKey);
        const newFence = existingFence ? existingFence.fencingToken + 1 : 1;
        mockRedisStore.set(fenceKey, { fencingToken: newFence });
        mockRedisStore.set(key, { value: token, expiresAt: ttl != null ? Date.now() + ttl : null });

        return newFence;
      }

      // Release script
      const token = args[1];
      const existing = mockRedisStore.get(key);
      if (existing && existing.value === token) { mockRedisStore.delete(key); return 1; }
      return 0;
    }
    async quit() { return 'OK'; }
  };
});

// ── Persistence + Stellar mocks ──────────────────────────────────────────────
jest.mock('../src/models/paymentModel', () => ({
  findOne: (...args) => mockFindOneImpl(...args),
  aggregate: async () => [],
  create: async (docs) => {
    const data = Array.isArray(docs) ? docs[0] : docs;
    const key = `${data.schoolId}|${data.txHash}`;
    if (mockSeenKeys.has(key)) {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    }
    mockSeenKeys.add(key);
    mockPayments.push(data);
    return [data];
  },
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: async () => ({ studentId: 's1', schoolId: 'school-1', feeAmount: 100 }),
  findOneAndUpdate: async () => ({}),
}));

jest.mock('../src/models/schoolModel', () => ({
  find: (...args) => mockSchoolFind(...args),
}));

jest.mock('../src/config/stellarConfig', () => {
  const builder = {
    transactions: () => builder,
    forAccount: () => builder,
    order: () => builder,
    limit: () => builder,
    call: async () => ({ records: mockTxRecords }),
  };
  return { server: builder };
});

jest.mock('../src/services/stellarService', () => ({
  extractValidPayment: async () => ({ payOp: { amount: '50', from: 'GSENDER' }, memo: 's1', asset: 'XLM' }),
  validatePaymentAgainstFee: () => ({ valid: true }),
  detectMemoCollision: async () => ({ suspicious: false, reason: null }),
  detectCrossSchoolMemoCollision: async () => ({ suspicious: false, reason: null }),
  detectAbnormalPatterns: async () => ({ suspicious: false, reason: null }),
  checkConfirmationStatus: async () => true,
  determineConfirmationState: async () => ({
    state: 'confirmed',
    changed: true,
    confirmationStatus: 'confirmed',
    latestLedgerSequence: 102,
  }),
}));

jest.mock('../src/utils/paymentLimits', () => ({
  validatePaymentAmount: () => ({ valid: true }),
}));

jest.mock('../src/utils/generateReferenceCode', () => ({
  generateReferenceCode: async () => 'REF123',
}));

jest.mock('../src/services/sseService', () => ({ emit: jest.fn() }));

jest.mock('mongoose', () => ({
  connection: {
    startSession: async () => ({
      withTransaction: async (cb) => cb(),
      endSession: async () => {},
    }),
  },
}));

function loadReplica() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/services/transactionPollingService');
  });
  return mod;
}

const TX = { hash: 'TX1', created_at: '2026-06-18T00:00:00Z', ledger: 100, fee_paid: '100' };
const SCHOOL = { schoolId: 'school-1', stellarAddress: 'GABC' };

describe('transactionPollingService — distributed lock + dedup', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.MONGO_URI = 'mongodb://localhost/test';
    process.env.JWT_SECRET = 'test-secret';
    mockPayments.length = 0;
    mockSeenKeys.clear();
    mockRedisStore.clear();
    mockFindOneImpl = async () => null;
    mockTxRecords = [{ ...TX }];
    mockSchoolFind.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.useRealTimers();
  });

  describe('two replicas against the same school', () => {
    beforeEach(() => { process.env.REDIS_HOST = 'localhost'; });

    it('never creates duplicate Payment docs — second replica is lock-skipped', async () => {
      const replicaA = loadReplica();
      const replicaB = loadReplica();

      const [resA, resB] = await Promise.all([
        replicaA.pollSchoolTransactions(SCHOOL),
        replicaB.pollSchoolTransactions(SCHOOL),
      ]);

      // Exactly one payment recorded for the single incoming transaction.
      expect(mockPayments).toHaveLength(1);

      // Exactly one of the two workers was skipped by the lock.
      const skipped = [resA, resB].filter((r) => r.lockSkipped);
      expect(skipped).toHaveLength(1);
      const worked = [resA, resB].find((r) => !r.lockSkipped);
      expect(worked.processed).toBe(1);

      await replicaA.stopPolling();
      await replicaB.stopPolling();
    });
  });

  describe('unique index is the authoritative dedup guard (not the pre-check)', () => {
    beforeEach(() => { process.env.REDIS_HOST = 'localhost'; });

    it('rejects the duplicate insert via code 11000 when both workers miss the pre-check', async () => {
      // Simulate the read-then-write race: both workers see no existing row.
      mockFindOneImpl = async () => null;
      const replica = loadReplica();

      const [r1, r2] = await Promise.all([
        replica.processTransaction({ ...TX }, SCHOOL),
        replica.processTransaction({ ...TX }, SCHOOL),
      ]);

      // The index let exactly one insert through; the other was rejected.
      expect(mockPayments).toHaveLength(1);
      const results = [r1, r2];
      expect(results.filter((r) => r.processed)).toHaveLength(1);
      const rejected = results.find((r) => !r.processed);
      expect(rejected.reason).toBe('duplicate');
    });
  });

  describe('poll interval is configurable via env (SYNC_INTERVAL_MS)', () => {
    it('drives the interval from config.SYNC_INTERVAL_MS', () => {
      process.env.SYNC_INTERVAL_MS = '17000';
      delete process.env.POLL_INTERVAL_MS;
      const replica = loadReplica();
      expect(replica._getBackoffState().currentIntervalMs).toBe(17000);
    });

    it('disables polling entirely when SYNC_INTERVAL_MS=0', () => {
      process.env.SYNC_INTERVAL_MS = '0';
      const replica = loadReplica();
      replica.startPolling();
      // Disabled: the cycle never ran, so active schools were never queried.
      expect(mockSchoolFind).not.toHaveBeenCalled();
    });
  });
});
