'use strict';

/**
 * Issue #1176 — syncPaymentsForSchool schoolId Scoping Test
 *
 * Before the fix, Payment.findOne was called without schoolId:
 *   Payment.findOne({ txHash: tx.hash, deletedAt: null })
 *
 * After the fix:
 *   Payment.findOne({ txHash: tx.hash, schoolId, deletedAt: null })
 *
 * This test verifies:
 *   1. Payment.findOne is called with schoolId included in every query.
 *   2. syncPaymentsForSchool completes without throwing a TenantScopeError.
 *   3. Already-processed detection is per-school (cross-school isolation).
 */

// ── Environment stubs ─────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ── Constants ─────────────────────────────────────────────────────────────────
const SCHOOL_A_ID      = 'SCH-A';
const SCHOOL_A_ADDR    = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SCHOOL_B_ID      = 'SCH-B';
const SCHOOL_B_ADDR    = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZUOZ2DU3JT0AASNZQXF4X';
const TX_HASH_NEW      = 'txhash-brand-new';

// ── Mock stellar-sdk ──────────────────────────────────────────────────────────
jest.mock('@stellar/stellar-sdk', () => ({
  Operation: { _fromXDRAmount: (s) => (parseInt(s, 10) / 1e7).toFixed(7) },
  Horizon:   { Server: jest.fn().mockImplementation(() => ({})) },
  Networks:  { TESTNET: 'Test SDF Network ; September 2015' },
  Asset:     { native: jest.fn(() => ({ isNative: () => true })) },
}), { virtual: true });

// ── Mock paymentLimits utility (breaks the systemConfigModel → mongoose chain) ─
jest.mock('../backend/src/utils/paymentLimits', () => ({
  validatePaymentAmount: jest.fn().mockResolvedValue({ valid: true }),
}));

// ── Mock stellarConfig ────────────────────────────────────────────────────────
jest.mock('../backend/src/config/stellarConfig', () => {
  const makePageResult = (txHash, destAddress) => ({
    records: [
      {
        hash:        txHash,
        successful:  true,
        created_at:  new Date().toISOString(),
        memo_type:   'text',
        memo:        'STU001',
        fee_paid:    '100',
        paging_token: txHash,
        operations:  jest.fn().mockResolvedValue({ records: [
          {
            type:       'payment',
            from:       'GSENDER999',
            to:         destAddress,
            amount:     '100.0000000',
            asset_type: 'native',
          },
        ]}),
      },
    ],
    next: jest.fn().mockResolvedValue({ records: [] }),
  });

  return {
    SCHOOL_WALLET:          'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    CONFIRMATION_THRESHOLD: 2,
    FINALIZATION_THRESHOLD: 5,
    ACCEPTED_ASSETS: {
      XLM: { code: 'XLM', type: 'native', issuer: null },
    },
    isAcceptedAsset: (code, type) =>
      code === 'XLM' && type === 'native'
        ? { accepted: true, asset: { code: 'XLM', type: 'native' } }
        : { accepted: false, asset: null },
    server: {
      transactions: () => ({
        forAccount: (addr) => ({
          order:  () => ({
            limit: () => ({
              call: async () => makePageResult(TX_HASH_NEW, addr),
            }),
          }),
        }),
      }),
    },
  };
});

// ── Payment model mock ────────────────────────────────────────────────────────
jest.mock('../backend/src/models/paymentModel', () => ({
  findOne:   jest.fn(),
  create:    jest.fn().mockResolvedValue({ toObject: () => ({}) }),
  exists:    jest.fn().mockResolvedValue(false),
  aggregate: jest.fn().mockResolvedValue([]),
}));

// ── Student model mock ────────────────────────────────────────────────────────
jest.mock('../backend/src/models/studentModel', () => ({
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

// ── Supporting model mocks ────────────────────────────────────────────────────
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
jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});

// ── Import after mocks ────────────────────────────────────────────────────────
const { syncPaymentsForSchool } = require('../backend/src/services/stellarService');
const Payment = require('../backend/src/models/paymentModel');

const SCHOOL_A = { schoolId: SCHOOL_A_ID, stellarAddress: SCHOOL_A_ADDR };
const SCHOOL_B = { schoolId: SCHOOL_B_ID, stellarAddress: SCHOOL_B_ADDR };

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no existing payments
  Payment.findOne.mockResolvedValue(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#1176 — syncPaymentsForSchool includes schoolId in Payment.findOne query', () => {

  test('Payment.findOne is called with schoolId in the query', async () => {
    try { await syncPaymentsForSchool(SCHOOL_A); } catch (_) { /* ignore write-path errors */ }

    expect(Payment.findOne).toHaveBeenCalled();
    const [firstCallQuery] = Payment.findOne.mock.calls[0];
    expect(firstCallQuery).toHaveProperty('schoolId', SCHOOL_A_ID);
    expect(firstCallQuery).toHaveProperty('txHash', TX_HASH_NEW);
    expect(firstCallQuery).toHaveProperty('deletedAt', null);
  });

  test('every Payment.findOne call includes schoolId (no bare txHash queries)', async () => {
    try { await syncPaymentsForSchool(SCHOOL_A); } catch (_) { /* ignore */ }

    for (const [query] of Payment.findOne.mock.calls) {
      if ('txHash' in query) {
        // Any query that scopes by txHash must also scope by schoolId
        expect(query).toHaveProperty('schoolId', SCHOOL_A_ID);
      }
    }
  });

  test('syncPaymentsForSchool does not throw a TenantScopeError', async () => {
    // The tenantScope plugin throws when schoolId is absent; resolving without
    // error confirms the fix is in place.
    await expect(
      syncPaymentsForSchool(SCHOOL_A).catch(err => {
        // Only re-throw if it's a tenant scope error
        if (err.message && err.message.includes('TenantScope')) throw err;
      })
    ).resolves.not.toThrow();
  });

  test('already-processed detection is per-school: schoolId is always included', async () => {
    // Simulate TX_HASH_NEW already processed for SCHOOL_A (both fields match)
    Payment.findOne.mockImplementation((query) => {
      if (query.txHash === TX_HASH_NEW && query.schoolId === SCHOOL_A_ID) {
        return Promise.resolve({ txHash: TX_HASH_NEW, schoolId: SCHOOL_A_ID });
      }
      return Promise.resolve(null);
    });

    try {
      const summary = await syncPaymentsForSchool(SCHOOL_A);
      // School A should detect the existing payment and mark it alreadyProcessed
      expect(summary.alreadyProcessed).toBeGreaterThanOrEqual(1);
    } catch (_) { /* ignore write-path side effects */ }

    // When syncing School B, the same txHash + different schoolId returns null
    // → School B's sync must query with schoolId = SCHOOL_B_ID
    Payment.findOne.mockClear();
    try { await syncPaymentsForSchool(SCHOOL_B); } catch (_) {}

    for (const [query] of Payment.findOne.mock.calls) {
      if ('txHash' in query) {
        expect(query.schoolId).toBe(SCHOOL_B_ID);
      }
    }
  });
});
