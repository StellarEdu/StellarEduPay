'use strict';

// #465 — partial feeValidationStatus

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ─── Mocks (all at top level so Jest hoisting works) ─────────────────────────

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  CONFIRMATION_THRESHOLD: 2,
  ACCEPTED_ASSETS: { XLM: { code: 'XLM', type: 'native', issuer: null } },
  isAcceptedAsset: (code, type) =>
    code === 'XLM' && type === 'native'
      ? { accepted: true, asset: { code, type } }
      : { accepted: false, asset: null },
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                {
                  hash: 'txhash001',
                  successful: true,
                  memo_type: 'text',
                  memo: 'STU001',
                  created_at: new Date().toISOString(),
                  ledger_attr: 98,
                  operations: async () => ({
                    records: [
                      {
                        type: 'payment',
                        to: 'GSCHOOL',
                        from: 'GPARENT',
                        amount: '50',
                        asset_type: 'native',
                      },
                    ],
                  }),
                },
              ],
            }),
          }),
        }),
      }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [{ sequence: 100 }] }),
        }),
      }),
    }),
  },
}));

jest.mock('../backend/src/utils/withStellarRetry', () => ({
  withStellarRetry: (fn) => fn(),
}));

jest.mock('../backend/src/utils/paymentLimits', () => ({
  validatePaymentAmount: () => ({ valid: true }),
}));

const mockSavePayment = jest.fn().mockResolvedValue({});
jest.mock('../backend/src/services/transactionService', () => ({
  savePayment: mockSavePayment,
}));

const mockPaymentFindOne = jest.fn().mockResolvedValue(null);
const mockPaymentAggregate = jest.fn().mockResolvedValue([]);
jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: mockPaymentFindOne,
  aggregate: mockPaymentAggregate,
  countDocuments: jest.fn().mockResolvedValue(0),
}));

const mockIntentFindOne = jest.fn().mockResolvedValue({
  _id: 'intent1',
  studentId: 'STU001',
  amount: 100,
  feeCategory: null,
  memo: 'STU001',
  status: 'pending',
});
jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: mockIntentFindOne,
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

const mockStudentFindOne = jest.fn().mockResolvedValue({
  studentId: 'STU001',
  feeAmount: 100,
  fees: [],
});
jest.mock('../backend/src/models/studentModel', () => ({
  findOne: mockStudentFindOne,
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

// stellarService wraps savePayment in a mongoose transaction session. Without a
// mock, mongoose.connection.startSession() has no live DB and hangs to timeout.
// stellarService (backend/src/services) resolves the DUPLICATE backend copy.
jest.mock('../backend/node_modules/mongoose', () => ({
  connection: {
    startSession: jest.fn().mockResolvedValue({
      withTransaction: async (fn) => { await fn(); },
      endSession: jest.fn(),
    }),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

const { validatePaymentAgainstFee, syncPaymentsForSchool } = require('../backend/src/services/stellarService');

describe('#465 partial feeValidationStatus', () => {
  describe('validatePaymentAgainstFee', () => {
    it('returns valid when payment equals fee', () => {
      expect(validatePaymentAgainstFee(100, 100).status).toBe('valid');
    });

    it('returns overpaid when payment exceeds fee', () => {
      const r = validatePaymentAgainstFee(150, 100);
      expect(r.status).toBe('overpaid');
      expect(r.excessAmount).toBeCloseTo(50, 5);
    });

    it('returns underpaid when single payment is less than fee', () => {
      expect(validatePaymentAgainstFee(50, 100).status).toBe('underpaid');
    });
  });

  describe('syncPaymentsForSchool — cumulative partial status', () => {
    beforeEach(() => {
      mockSavePayment.mockClear();
      mockPaymentFindOne.mockResolvedValue(null);
      mockPaymentAggregate.mockResolvedValue([]); // no previous payments
    });

    it('sets feeValidationStatus to partial when cumulative payment < fee', async () => {
      // Payment of 50 against a fee of 100 → partial
      await syncPaymentsForSchool({ schoolId: 'SCH1', stellarAddress: 'GSCHOOL' });

      expect(mockSavePayment).toHaveBeenCalledWith(
        expect.objectContaining({ feeValidationStatus: 'partial' }),
        expect.anything(),
      );
    });

    it('sets feeValidationStatus to valid when cumulative payment equals fee', async () => {
      // Previous payments total 50, new payment 50 → cumulative 100 = fee
      mockPaymentAggregate.mockResolvedValue([{ total: 50 }]);

      await syncPaymentsForSchool({ schoolId: 'SCH1', stellarAddress: 'GSCHOOL' });

      expect(mockSavePayment).toHaveBeenCalledWith(
        expect.objectContaining({ feeValidationStatus: 'valid' }),
        expect.anything(),
      );
    });

    it('sets feeValidationStatus to overpaid when cumulative payment exceeds fee', async () => {
      // Previous payments total 80, new payment 50 → cumulative 130 > 100
      mockPaymentAggregate.mockResolvedValue([{ total: 80 }]);

      await syncPaymentsForSchool({ schoolId: 'SCH1', stellarAddress: 'GSCHOOL' });

      expect(mockSavePayment).toHaveBeenCalledWith(
        expect.objectContaining({ feeValidationStatus: 'overpaid' }),
        expect.anything(),
      );
    });
  });
});
