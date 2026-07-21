'use strict';

// Must set required env vars before any module that loads config/index.js
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-for-stellar-service-suite';

// #606 — Mock the Stellar SDK so tests never make real network calls
jest.mock('@stellar/stellar-sdk', () => ({
  Operation: {
    payment: jest.fn(),
    // Converts a stroop integer string back to a decimal XLM string (1 stroop = 0.0000001 XLM)
    _fromXDRAmount: (stroops) => (parseInt(stroops, 10) / 1e7).toFixed(7),
  },
  Horizon: { Server: jest.fn().mockImplementation(() => ({})) },
  Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
  Asset: { native: jest.fn(() => ({ isNative: () => true })) },
}), { virtual: true });

// syncPaymentsForSchool's "matched" path wraps the write in a session/transaction —
// mock mongoose so no real MongoDB connection is required.
var mockWithTransaction = jest.fn(async (cb) => cb());
var mockEndSession = jest.fn().mockResolvedValue(undefined);
var mockStartSession = jest.fn().mockResolvedValue({
  withTransaction: mockWithTransaction,
  endSession: mockEndSession,
});
// stellarService.js resolves 'mongoose' from backend/node_modules (its own
// install, separate from the root-level copy) — mock that exact resolved
// path so the session stub actually intercepts the call.
jest.mock(require.resolve('../backend/node_modules/mongoose'), () => ({
  connection: { startSession: mockStartSession },
}));

// savePayment (transactionService) writes an outbox event alongside the payment.
jest.mock('../backend/src/models/outboxModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

const {
  verifyTransaction,
  syncPaymentsForSchool,
  parseIncomingTransaction,
  validatePaymentAgainstFee,
  detectAsset,
  normalizeAmount,
  extractValidPayment,
} = require('../backend/src/services/stellarService');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockOperations = jest.fn();

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  CONFIRMATION_THRESHOLD: 2,
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GISSUER' },
  },
  isAcceptedAsset: (code, type) => {
    const map = { XLM: 'native', USDC: 'credit_alphanum4' };
    if (map[code] && map[code] === type) return { accepted: true, asset: { code, type } };
    return { accepted: false, asset: null };
  },
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: [], next: async () => ({ records: [] }) }) }) }),
      }),
      transaction: (txHash) => ({
        call: async () => ({
          hash: txHash,
          memo: 'STU001',
          memo_type: 'text',
          successful: true,
          created_at: new Date().toISOString(),
          operations: mockOperations,
        }),
      }),
    }),
    ledgers: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: [{ sequence: 100 }] }) }) }),
    }),
  },
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn(),
  create: jest.fn().mockResolvedValue({ toObject: () => ({}) }),
  exists: jest.fn().mockResolvedValue(false),
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn().mockResolvedValue({ _id: 'intent123', studentId: 'STU001', amount: 200, memo: 'STU001', status: 'pending' }),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

const Payment = require('../backend/src/models/paymentModel');
const Student = require('../backend/src/models/studentModel');

// ─── validatePaymentAgainstFee ────────────────────────────────────────────────

describe('validatePaymentAgainstFee', () => {
  test('valid when payment equals fee', () => {
    expect(validatePaymentAgainstFee(200, 200).status).toBe('valid');
  });

  test('underpaid when payment is less than fee', () => {
    expect(validatePaymentAgainstFee(150, 200).status).toBe('underpaid');
  });

  test('overpaid when payment exceeds fee', () => {
    expect(validatePaymentAgainstFee(250, 200).status).toBe('overpaid');
  });

  test('messages include the amounts', () => {
    expect(validatePaymentAgainstFee(50, 200).message).toContain('50');
    expect(validatePaymentAgainstFee(50, 200).message).toContain('200');
  });
});

// ─── detectAsset ─────────────────────────────────────────────────────────────

describe('detectAsset', () => {
  test('recognizes native XLM', () => {
    expect(detectAsset({ asset_type: 'native' })).toEqual({
      assetCode: 'XLM',
      assetType: 'native',
      assetIssuer: null,
    });
  });

  test('recognizes USDC', () => {
    expect(detectAsset({ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' })).toEqual({
      assetCode: 'USDC',
      assetType: 'credit_alphanum4',
      assetIssuer: 'GISSUER',
    });
  });

  test('returns null for unsupported asset', () => {
    expect(detectAsset({ asset_type: 'credit_alphanum4', asset_code: 'SHIB', asset_issuer: 'GRANDOM' })).toBeNull();
  });

  test('returns null when asset type does not match', () => {
    // XLM code but wrong type
    expect(detectAsset({ asset_type: 'credit_alphanum4', asset_code: 'XLM', asset_issuer: 'GISSUER' })).toBeNull();
  });
});

// ─── normalizeAmount ──────────────────────────────────────────────────────────

describe('normalizeAmount', () => {
  // Horizon returns decimal strings; normalizeAmount must use the SDK's
  // Operation._fromXDRAmount as the canonical 7-decimal-place conversion so
  // that XLM and USDC amounts are treated identically.

  test('handles whole numbers', () => {
    expect(normalizeAmount('200')).toBe(200);
  });

  test('handles Horizon-style 7-decimal strings', () => {
    expect(normalizeAmount('100.0000000')).toBe(100);
    expect(normalizeAmount('250.0000000')).toBe(250);
  });

  test('rounds to 7 decimal places', () => {
    expect(normalizeAmount('100.123456789')).toBe(100.1234568);
  });

  // Edge case: minimum representable amount (1 stroop = 0.0000001)
  test('handles 1 stroop — minimum amount', () => {
    expect(normalizeAmount('0.0000001')).toBe(0.0000001);
  });

  // Edge case: maximum Stellar amount (max int64 / 1e7 ≈ 922337203685.4775807)
  test('handles maximum Stellar amount', () => {
    // Operation._fromXDRAmount uses the same 1e7 divisor for all assets
    const max = normalizeAmount('922337203685.4775807');
    expect(max).toBeCloseTo(922337203685.4775807, 5);
  });

  // XLM and USDC both use 7 decimal places on Stellar — normalization must be identical
  test('XLM and USDC amounts normalize identically for the same raw value', () => {
    const xlmAmount = normalizeAmount('250.0000000');
    const usdcAmount = normalizeAmount('250.0000000');
    expect(xlmAmount).toBe(usdcAmount);
  });

  test('XLM and USDC 1-stroop amounts normalize identically', () => {
    expect(normalizeAmount('0.0000001')).toBe(normalizeAmount('0.0000001'));
  });
});

// ─── extractValidPayment ──────────────────────────────────────────────────────

describe('extractValidPayment', () => {
  const validOps = async () => ({
    records: [{ type: 'payment', to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '100.0', asset_type: 'native' }],
  });

  test('returns payOp, memo, asset for a valid transaction', async () => {
    const tx = { successful: true, memo: 'STU001', memo_type: 'text', operations: validOps };
    const result = await extractValidPayment(tx, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(result).not.toBeNull();
    expect(result.memo).toBe('STU001');
    expect(result.asset.assetCode).toBe('XLM');
  });

  test('returns null for a failed transaction', async () => {
    const tx = { successful: false, memo: 'STU001', operations: validOps };
    expect(await extractValidPayment(tx, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBeNull();
  });

  test('returns null when memo is missing', async () => {
    const tx = { successful: true, memo: undefined, operations: validOps };
    expect(await extractValidPayment(tx, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBeNull();
  });

  test('returns null when memo is empty string', async () => {
    const tx = { successful: true, memo: '   ', operations: validOps };
    expect(await extractValidPayment(tx, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBeNull();
  });

  test('returns null when no payment op to school wallet', async () => {
    const tx = {
      successful: true,
      memo: 'STU001',
      operations: async () => ({ records: [{ type: 'payment', to: 'GOTHER', amount: '100.0', asset_type: 'native' }] }),
    };
    expect(await extractValidPayment(tx, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBeNull();
  });

  test('returns null for unsupported asset', async () => {
    const tx = {
      successful: true,
      memo: 'STU001',
      operations: async () => ({
        records: [{ type: 'payment', to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '100.0', asset_type: 'credit_alphanum4', asset_code: 'SHIB', asset_issuer: 'GRANDOM' }],
      }),
    };
    expect(await extractValidPayment(tx, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBeNull();
  });
});

// ─── verifyTransaction ────────────────────────────────────────────────────────

describe('verifyTransaction', () => {
  beforeEach(() => {
    Student.findOne.mockResolvedValue({ studentId: 'STU001', feeAmount: 100 });
  });

  test('returns payment details with asset info for a valid XLM transaction', async () => {
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '100.0', asset_type: 'native' }],
    });
    const result = await verifyTransaction('abc123', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(result).toMatchObject({ hash: 'abc123', memo: 'STU001', amount: 100, assetCode: 'XLM', assetType: 'native' });
    expect(result.feeValidation.status).toBe('valid');
  });

  test('throws INVALID_DESTINATION when no matching payment op', async () => {
    mockOperations.mockResolvedValue({ records: [] });
    await expect(verifyTransaction('abc123', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
  });

  test('throws INVALID_DESTINATION when payment is to a different wallet', async () => {
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GOTHER999', amount: '100.0', asset_type: 'native' }],
    });
    await expect(verifyTransaction('abc123', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
  });

  test('throws UNSUPPORTED_ASSET for unsupported asset', async () => {
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '100.0', asset_type: 'credit_alphanum4', asset_code: 'SHIB', asset_issuer: 'GRANDOM' }],
    });
    await expect(verifyTransaction('abc123', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET' });
  });

  test('feeValidation status is unknown when student not found', async () => {
    Student.findOne.mockResolvedValue(null);
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '100.0', asset_type: 'native' }],
    });
    const result = await verifyTransaction('abc123', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(result.feeValidation.status).toBe('unknown');
  });
});

// ─── parseIncomingTransaction ─────────────────────────────────────────────────

describe('parseIncomingTransaction', () => {
  test('correctly extracts memo and amount from payment op', async () => {
    const txHash = 'abc123';

    mockOperations.mockResolvedValue({
      records: [
        { type: 'payment', from: 'GFROM', to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '150.0', asset_type: 'native' },
        { type: 'payment', from: 'GFROM', to: 'GOTHER', amount: '50.0', asset_type: 'native' },
      ],
    });

    const parsed = await parseIncomingTransaction(txHash, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(parsed.memo).toBe('STU001');
    expect(parsed.payments).toHaveLength(1);
    expect(parsed.payments[0]).toMatchObject({
      from: 'GFROM',
      to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: 150.0,
      assetCode: 'XLM',
      assetType: 'native',
    });
  });
});

// ─── syncPayments ─────────────────────────────────────────────────────────────

// Shared mock transaction factory for sync tests
function makeSyncTx(amount, memo = 'STU001') {
  return {
    hash: `tx-${amount}`,
    successful: true,
    memo,
    memo_type: 'text',
    created_at: new Date().toISOString(),
    ledger_attr: 90, // below CONFIRMATION_THRESHOLD of 2 from sequence 100 → confirmed
    operations: jest.fn().mockResolvedValue({
      records: [{
        type: 'payment',
        to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        from: 'GSENDER',
        amount: String(amount),
        asset_type: 'native',
      }],
    }),
  };
}

const stellarConfig = require('../backend/src/config/stellarConfig');

describe('syncPaymentsForSchool', () => {
  const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };

  beforeEach(() => {
    jest.clearAllMocks();
    Payment.findOne.mockResolvedValue(null); // tx not yet recorded
    Payment.exists.mockResolvedValue(false);
    Payment.create.mockResolvedValue({ toObject: () => ({}) });
    Payment.aggregate.mockResolvedValue([]);
    mockWithTransaction.mockImplementation(async (cb) => cb());
    mockStartSession.mockResolvedValue({
      withTransaction: mockWithTransaction,
      endSession: mockEndSession,
    });
  });

  test('resolves without error when no transactions exist', async () => {
    await expect(syncPaymentsForSchool(school)).resolves.toBeDefined();
  });

  test('skips transaction with unmatched memo (no matching student)', async () => {
    const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };
    
    // Transaction with memo that doesn't match any student
    const unmatchedTx = makeSyncTx(100, 'UNKNOWN_STUDENT_999');
    
    // Override stellarConfig mock to return our unmatched transaction
    const stellarConfig = require('../backend/src/config/stellarConfig');
    const origTransactions = stellarConfig.server.transactions;
    stellarConfig.server.transactions = () => ({
      forAccount: () => ({
        order: () => ({ 
          limit: () => ({ 
            call: async () => ({ 
              records: [unmatchedTx], 
              next: async () => ({ records: [] }) 
            }) 
          }) 
        }),
      }),
    });

    // Mock PaymentIntent to return null (no matching intent for this memo)
    const PaymentIntent = require('../backend/src/models/paymentIntentModel');
    PaymentIntent.findOne.mockResolvedValue(null);

    // Track if Payment.create was called
    const createSpy = Payment.create;
    
    // Track if Student.findOneAndUpdate was called
    const studentUpdateSpy = Student.findOneAndUpdate;

    await syncPaymentsForSchool(school);

    // Verify no payment was created
    expect(createSpy).not.toHaveBeenCalled();
    
    // Verify no student was updated
    expect(studentUpdateSpy).not.toHaveBeenCalled();

    // Restore
    stellarConfig.server.transactions = origTransactions;
  });

  test('skips transaction with no memo field', async () => {
    const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };
    
    // Transaction with no memo
    const noMemoTx = {
      hash: 'tx-no-memo',
      successful: true,
      memo: undefined, // No memo field
      created_at: new Date().toISOString(),
      ledger_attr: 90,
      operations: jest.fn().mockResolvedValue({
        records: [{
          type: 'payment',
          to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          from: 'GSENDER',
          amount: '100.0',
          asset_type: 'native',
        }],
      }),
    };
    
    // Override stellarConfig mock to return transaction without memo
    const stellarConfig = require('../backend/src/config/stellarConfig');
    const origTransactions = stellarConfig.server.transactions;
    stellarConfig.server.transactions = () => ({
      forAccount: () => ({
        order: () => ({ 
          limit: () => ({ 
            call: async () => ({ 
              records: [noMemoTx], 
              next: async () => ({ records: [] }) 
            }) 
          }) 
        }),
      }),
    });

    // Track if Payment.create was called
    const createSpy = Payment.create;
    
    // Track if Student.findOneAndUpdate was called
    const studentUpdateSpy = Student.findOneAndUpdate;

    // Should not throw error
    await expect(syncPaymentsForSchool(school)).resolves.toBeDefined();

    // Verify no payment was created
    expect(createSpy).not.toHaveBeenCalled();
    
    // Verify no student was updated
    expect(studentUpdateSpy).not.toHaveBeenCalled();

    // Restore
    stellarConfig.server.transactions = origTransactions;
  });

  test('skips transaction with empty string memo', async () => {
    const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };
    
    // Transaction with empty memo
    const emptyMemoTx = makeSyncTx(100, '   '); // Whitespace-only memo
    
    // Override stellarConfig mock
    const stellarConfig = require('../backend/src/config/stellarConfig');
    const origTransactions = stellarConfig.server.transactions;
    stellarConfig.server.transactions = () => ({
      forAccount: () => ({
        order: () => ({ 
          limit: () => ({ 
            call: async () => ({ 
              records: [emptyMemoTx], 
              next: async () => ({ records: [] }) 
            }) 
          }) 
        }),
      }),
    });

    // Track calls
    const createSpy = Payment.create;
    const studentUpdateSpy = Student.findOneAndUpdate;

    await syncPaymentsForSchool(school);

    // Verify no payment was created
    expect(createSpy).not.toHaveBeenCalled();
    
    // Verify no student was updated
    expect(studentUpdateSpy).not.toHaveBeenCalled();

    // Restore
    stellarConfig.server.transactions = origTransactions;
  });

  test('records payment for memo matching a soft-deleted student instead of dropping it (flagged for manual review)', async () => {
    const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };
    const tx = makeSyncTx(100, 'STU_DEL');

    const stellarConfig = require('../backend/src/config/stellarConfig');
    const origTransactions = stellarConfig.server.transactions;
    stellarConfig.server.transactions = () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [tx], next: async () => ({ records: [] }) }),
          }),
        }),
      }),
    });

    // No pending intent for this memo — falls back to a direct studentId lookup.
    const PaymentIntent = require('../backend/src/models/paymentIntentModel');
    PaymentIntent.findOne.mockResolvedValue(null);

    // Active lookup misses (the student is soft-deleted, excluded by the
    // softDelete plugin); the explicit deletedAt-filtered lookup finds them.
    Student.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ schoolId: 'SCH001', studentId: 'STU_DEL', feeAmount: 100, deletedAt: new Date() });

    const summary = await syncPaymentsForSchool(school);

    // Funds are recorded, not silently unmatched.
    expect(Payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: tx.hash, studentId: 'STU_DEL', studentDeleted: true }),
      expect.anything(),
    );
    // The deleted student's stored balance is never mutated.
    expect(Student.findOneAndUpdate).not.toHaveBeenCalled();
    expect(summary.unmatched).toBe(0);

    stellarConfig.server.transactions = origTransactions;
  });

  test('credits a transaction whose memo matches an already-completed payment intent (intent-decoupled fallback match)', async () => {
    const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };
    const tx = makeSyncTx(100, 'STU001');

    const stellarConfig = require('../backend/src/config/stellarConfig');
    const origTransactions = stellarConfig.server.transactions;
    stellarConfig.server.transactions = () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [tx], next: async () => ({ records: [] }) }),
          }),
        }),
      }),
    });

    // The intent for this memo is already completed — the pending-only query finds nothing.
    const PaymentIntent = require('../backend/src/models/paymentIntentModel');
    PaymentIntent.findOne.mockResolvedValue(null);

    // Fallback direct studentId lookup finds the (still-active) student.
    Student.findOne.mockResolvedValueOnce({ schoolId: 'SCH001', studentId: 'STU001', feeAmount: 100 });

    const summary = await syncPaymentsForSchool(school);

    // The late/duplicate transaction is credited to the student, not dropped.
    expect(Payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: tx.hash, studentId: 'STU001', studentDeleted: false }),
      expect.anything(),
    );
    expect(Student.findOneAndUpdate).toHaveBeenCalled();
    // No pending intent existed, so nothing is marked completed a second time.
    expect(PaymentIntent.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(summary.unmatched).toBe(0);

    stellarConfig.server.transactions = origTransactions;
  });

  test('stops pagination when a known txHash is encountered', async () => {
    const school = { schoolId: 'SCH001', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };

    // 200 new records on page 1 (full page → triggers next())
    const page1Records = Array.from({ length: 200 }, (_, i) => ({
      hash: `tx_new_${i}`, successful: false, memo: null, created_at: new Date().toISOString(),
    }));
    // Page 2 has one already-known record → pagination stops
    const page2Records = [{ hash: 'known_tx', successful: false, memo: null, created_at: new Date().toISOString() }];

    const nextFn = jest.fn().mockResolvedValue({ records: page2Records, next: jest.fn() });

    // Override the stellarConfig mock for this test only
    const stellarConfig = require('../backend/src/config/stellarConfig');
    const origTransactions = stellarConfig.server.transactions;
    stellarConfig.server.transactions = () => ({
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: page1Records, next: nextFn }) }) }),
      }),
    });

    // All page1 records are new (null), then the page2 record is known
    Payment.findOne
      .mockResolvedValue(null)
      .mockResolvedValueOnce({ hash: 'known_tx' }); // called for page2[0] → stop

    // Reset so page1 records all return null first
    Payment.findOne.mockReset();
    Payment.findOne.mockResolvedValue(null); // default: all unknown
    // Override for the first call on page2 (201st call overall)
    const calls = [];
    Payment.findOne.mockImplementation(({ txHash }) => {
      calls.push(txHash);
      if (txHash === 'known_tx') return Promise.resolve({ hash: 'known_tx' });
      return Promise.resolve(null);
    });

    await syncPaymentsForSchool(school);

    expect(nextFn).toHaveBeenCalledTimes(1);

    // Restore
    stellarConfig.server.transactions = origTransactions;
    Payment.findOne.mockReset();
    Payment.findOne.mockResolvedValue(null);
  });
});
