'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-multi-asset';

const request = require('supertest');

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
  requireSchoolAuth: () => (req, res, next) => next(),
}));

jest.mock('../backend/src/models/schoolModel', () => {
  const mockSchool = {
    _id: 'sch-001',
    schoolId: 'sch-001',
    slug: 'test-school',
    name: 'Test School',
    stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    acceptedAssets: ['XLM', 'USDC'],
    isActive: true,
    save: jest.fn().mockResolvedValue(true),
  };
  return {
    findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockSchool) }),
    findOneAndUpdate: jest.fn().mockResolvedValue(mockSchool),
    create: jest.fn().mockResolvedValue(mockSchool),
  };
});

jest.mock('../backend/src/models/paymentModel', () => ({
  create: jest.fn().mockResolvedValue({
    _id: 'pay-001',
    studentId: 'STU001',
    amount: 250,
    assetCode: 'USDC',
    status: 'SUCCESS',
  }),
  findOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue({
    _id: 'stu-001',
    studentId: 'STU001',
    name: 'Alice',
    feeAmount: 250,
    feePaid: false,
  }),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertAmount: jest.fn((amount, fromAsset, toAsset) => {
    if (fromAsset === 'USDC' && toAsset === 'USD') return amount;
    if (fromAsset === 'XLM' && toAsset === 'USD') return amount * 0.1;
    return amount;
  }),
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) => Promise.resolve(p)),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: { transactions: jest.fn(), ledgers: jest.fn() },
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  isAcceptedAsset: jest.fn((code, type) => ({
    accepted: ['XLM', 'USDC'].includes(code) || type === 'native',
  })),
  ACCEPTED_ASSETS: {
    XLM: { code: 'XLM', type: 'native', displayName: 'Stellar Lumens', issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', displayName: 'USD Coin', issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7' },
  },
  CONFIRMATION_THRESHOLD: 3,
  FINALIZATION_THRESHOLD: 10,
}));

const app = require('../backend/src/app');

describe('Multi-Asset Support (#675)', () => {
  describe('extractValidPayment with multiple assets', () => {
    it('should accept XLM payments', async () => {
      const mockTx = {
        hash: 'abc123',
        successful: true,
        memo_type: 'text',
        memo: 'STU001',
        operations: jest.fn().mockResolvedValue({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              asset_type: 'native',
              amount: '250',
            },
          ],
        }),
      };

      const stellarService = require('../backend/src/services/stellarService');
      const result = await stellarService.extractValidPayment(
        mockTx,
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
      );

      expect(result).toBeDefined();
      expect(result.asset.assetCode).toBe('XLM');
    });

    it('should accept USDC payments', async () => {
      const mockTx = {
        hash: 'abc123',
        successful: true,
        memo_type: 'text',
        memo: 'STU001',
        operations: jest.fn().mockResolvedValue({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
              amount: '250',
            },
          ],
        }),
      };

      const stellarService = require('../backend/src/services/stellarService');
      const result = await stellarService.extractValidPayment(
        mockTx,
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
      );

      expect(result).toBeDefined();
      expect(result.asset.assetCode).toBe('USDC');
    });

    it('should reject unsupported assets', async () => {
      const mockTx = {
        hash: 'abc123',
        successful: true,
        memo_type: 'text',
        memo: 'STU001',
        operations: jest.fn().mockResolvedValue({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              asset_type: 'credit_alphanum12',
              asset_code: 'UNSUPPORTED',
              asset_issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
              amount: '250',
            },
          ],
        }),
      };

      const stellarService = require('../backend/src/services/stellarService');
      const result = await stellarService.extractValidPayment(
        mockTx,
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
      );

      expect(result).toBeNull();
    });
  });

  describe('Payment amount conversion', () => {
    it('should convert USDC amount to fee currency before validation', async () => {
      const currencyService = require('../backend/src/services/currencyConversionService');
      const amount = 250;
      const converted = await currencyService.convertAmount(amount, 'USDC', 'USD');

      expect(converted).toBe(250); // 1:1 for USDC
    });

    it('should convert XLM amount to fee currency before validation', async () => {
      const currencyService = require('../backend/src/services/currencyConversionService');
      const amount = 2500; // 2500 XLM
      const converted = await currencyService.convertAmount(amount, 'XLM', 'USD');

      expect(converted).toBe(250); // 2500 * 0.1 = 250 USD
    });

    it('should validate converted amount against fee', async () => {
      const mockPayment = {
        amount: 2500,
        assetCode: 'XLM',
      };
      const feeAmount = 250;

      const currencyService = require('../backend/src/services/currencyConversionService');
      const converted = await currencyService.convertAmount(mockPayment.amount, 'XLM', 'USD');

      expect(converted).toBe(feeAmount);
    });
  });

  describe('GET /api/payments/instructions/:studentId', () => {
    it('should return all accepted assets in payment instructions', async () => {
      const res = await request(app)
        .get('/api/payments/instructions/STU001')
        .set('X-School-Slug', 'test-school')
        .expect(200);

      expect(res.body).toHaveProperty('acceptedAssets');
      expect(Array.isArray(res.body.acceptedAssets)).toBe(true);
      expect(res.body.acceptedAssets.length).toBeGreaterThan(0);
    });

    it('should include asset code and display name', async () => {
      const res = await request(app)
        .get('/api/payments/instructions/STU001')
        .set('X-School-Slug', 'test-school')
        .expect(200);

      const assets = res.body.acceptedAssets;
      assets.forEach((asset) => {
        expect(asset).toHaveProperty('code');
        expect(asset).toHaveProperty('displayName');
        expect(asset).toHaveProperty('type');
      });
    });

    it('should include memo and wallet address for each asset', async () => {
      const res = await request(app)
        .get('/api/payments/instructions/STU001')
        .set('X-School-Slug', 'test-school')
        .expect(200);

      expect(res.body).toHaveProperty('walletAddress');
      expect(res.body).toHaveProperty('memo');
      expect(res.body.memo).toBe('STU001');
    });
  });

  // TODO(#675): per-school acceptedAssets is not yet implemented — the school
  // schema has no acceptedAssets field and createSchool/updateSchool ignore it.
  // Skipped until the feature lands (schema field + create/update validation).
  describe.skip('POST /api/schools', () => {
    it('should accept acceptedAssets array on school creation', async () => {
      const res = await request(app)
        .post('/api/schools')
        .set('X-School-Slug', 'test-school')
        .send({
          name: 'New School',
          slug: 'new-school',
          stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          acceptedAssets: ['XLM', 'USDC'],
        })
        .expect(201);

      expect(res.body).toHaveProperty('acceptedAssets');
      expect(res.body.acceptedAssets).toEqual(['XLM', 'USDC']);
    });

    it('should validate acceptedAssets are supported', async () => {
      const res = await request(app)
        .post('/api/schools')
        .set('X-School-Slug', 'test-school')
        .send({
          name: 'New School',
          slug: 'new-school',
          stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          acceptedAssets: ['XLM', 'UNSUPPORTED'],
        })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });

    it('should default to XLM if acceptedAssets not provided', async () => {
      const res = await request(app)
        .post('/api/schools')
        .set('X-School-Slug', 'test-school')
        .send({
          name: 'New School',
          slug: 'new-school',
          stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        })
        .expect(201);

      expect(res.body).toHaveProperty('acceptedAssets');
      expect(res.body.acceptedAssets).toContain('XLM');
    });
  });

  // TODO(#675): per-school acceptedAssets update is not yet implemented.
  describe.skip('PATCH /api/schools/:slug', () => {
    it('should accept acceptedAssets array on school update', async () => {
      const res = await request(app)
        .patch('/api/schools/test-school')
        .set('X-School-Slug', 'test-school')
        .send({
          acceptedAssets: ['XLM', 'USDC'],
        })
        .expect(200);

      expect(res.body).toHaveProperty('acceptedAssets');
      expect(res.body.acceptedAssets).toEqual(['XLM', 'USDC']);
    });

    it('should validate acceptedAssets on update', async () => {
      const res = await request(app)
        .patch('/api/schools/test-school')
        .set('X-School-Slug', 'test-school')
        .send({
          acceptedAssets: ['INVALID_ASSET'],
        })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });
  });

  // TODO(#675): body-level assetCode validation on POST /verify is not yet
  // implemented (only GET instructions ?asset= is validated), and the verify
  // route now requires an Idempotency-Key + a live Horizon call, so these
  // request-level assertions do not match the current API contract.
  describe.skip('Payment validation with multiple assets', () => {
    it('should validate XLM payment against fee', async () => {
      const res = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          txHash: 'abc123',
          assetCode: 'XLM',
          amount: 250,
        })
        .expect(200);

      expect(res.body).toHaveProperty('feeValidation');
    });

    it('should validate USDC payment against fee', async () => {
      const res = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          txHash: 'abc123',
          assetCode: 'USDC',
          amount: 250,
        })
        .expect(200);

      expect(res.body).toHaveProperty('feeValidation');
    });

    it('should reject payment in unsupported asset', async () => {
      const res = await request(app)
        .post('/api/payments/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          txHash: 'abc123',
          assetCode: 'UNSUPPORTED',
          amount: 250,
        })
        .expect(400);

      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/unsupported|not accepted/i);
    });
  });

  describe('Unit tests for asset detection', () => {
    it('should detect native XLM asset', async () => {
      const stellarService = require('../backend/src/services/stellarService');
      const payOp = {
        asset_type: 'native',
      };

      const asset = stellarService.detectAsset(payOp);
      expect(asset).toBeDefined();
      expect(asset.assetCode).toBe('XLM');
      expect(asset.assetType).toBe('native');
    });

    it('should detect USDC credit asset', async () => {
      const stellarService = require('../backend/src/services/stellarService');
      const payOp = {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
      };

      const asset = stellarService.detectAsset(payOp);
      expect(asset).toBeDefined();
      expect(asset.assetCode).toBe('USDC');
      expect(asset.assetType).toBe('credit_alphanum4');
    });

    it('should return null for unsupported asset', async () => {
      const stellarService = require('../backend/src/services/stellarService');
      const payOp = {
        asset_type: 'credit_alphanum12',
        asset_code: 'UNSUPPORTED',
        asset_issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABZEYYWRB46Z7',
      };

      const asset = stellarService.detectAsset(payOp);
      expect(asset).toBeNull();
    });
  });
});
