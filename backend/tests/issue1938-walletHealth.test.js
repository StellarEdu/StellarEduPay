'use strict';

/**
 * Tests for issue #1938 — the wallet readiness evaluator must actually run on
 * create / update / rotate, expose a health endpoint, and feed a daily metric.
 */

// Horizon: each test sets the next account lookup result (or error).
const mockHorizon = { next: null };
const mockAccepted = { value: { XLM: { code: 'XLM', type: 'native' } } };

jest.mock('../src/config/stellarConfig', () => ({
  server: {
    accounts: () => ({
      accountId: () => ({
        call: () => {
          const next = mockHorizon.next;
          if (next instanceof Error) return Promise.reject(next);
          return Promise.resolve(next);
        },
      }),
    }),
  },
  get ACCEPTED_ASSETS() {
    return mockAccepted.value;
  },
}));

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('../src/models/schoolModel', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/services/stellarAccountVerificationService', () => ({
  verifyStellarAccountFunding: jest.fn(async () => ({ isFunded: true, warning: null })),
}));
jest.mock('../src/services/walletRotationService', () => ({
  buildWalletRotation: jest.fn(async () => ({ retired: {}, syncCursor: null, walletActiveFrom: new Date() })),
}));
jest.mock('../src/services/schoolCacheInvalidator', () => ({ invalidate: jest.fn() }));
jest.mock('../src/services/currencyConversionService', () => ({
  isSupportedCurrency: jest.fn(async () => ({ valid: true })),
}));

const SCHOOL_WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// A healthy account: funded, with a USDC trustline, multi-sig thresholds and memo_required.
function healthyAccount({ withUsdc = true } = {}) {
  const balances = [{ asset_type: 'native', balance: '50.0000000' }];
  if (withUsdc) {
    balances.push({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
      balance: '0.0000000',
      limit: '1000000.0000000',
      is_authorized: true,
    });
  }
  return {
    account_id: SCHOOL_WALLET,
    balances,
    subentry_count: withUsdc ? 1 : 0,
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
    signers: [{ key: SCHOOL_WALLET, weight: 2, type: 'ed25519_public_key' }],
    data_attr: { 'config.memo_required': Buffer.from('1').toString('base64') },
    home_domain: null,
  };
}

const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });

const { assessWallet, BLOCKING_CODES } = require('../src/services/walletHealthService');
const School = require('../src/models/schoolModel');
const schoolController = require('../src/controllers/schoolController');
const walletHealthScheduler = require('../src/services/walletHealthScheduler');
const { schoolWalletWarningGauge } = require('../src/metrics');
const { evaluateWalletReadiness } = require('../src/services/walletReadinessService');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function createReq(overrides = {}) {
  return {
    body: {
      name: 'Riverside Academy',
      slug: 'riverside',
      stellarAddress: SCHOOL_WALLET,
      network: 'testnet',
      ...overrides,
    },
    params: {},
    auditContext: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHorizon.next = healthyAccount();
  mockAccepted.value = { XLM: { code: 'XLM', type: 'native' } };
  School.create.mockImplementation(async (doc) => ({ ...doc, toJSON() { return { ...doc }; } }));
});

describe('issue #1938 — assessWallet', () => {
  test('a missing account blocks with ACCOUNT_NOT_FOUND', async () => {
    mockHorizon.next = notFound;
    const result = await assessWallet(SCHOOL_WALLET);
    expect(result.status).toBe('ok');
    expect(result.blockingCode).toBe('ACCOUNT_NOT_FOUND');
    expect(result.warnings.map((w) => w.code)).toContain('ACCOUNT_NOT_FOUND');
  });

  test('USDC accepted and no trustline blocks with USDC_TRUSTLINE_MISSING', async () => {
    mockAccepted.value = { XLM: { code: 'XLM' }, USDC: { code: 'USDC', issuer: USDC_ISSUER } };
    mockHorizon.next = healthyAccount({ withUsdc: false });
    const result = await assessWallet(SCHOOL_WALLET);
    expect(result.blockingCode).toBe('USDC_TRUSTLINE_MISSING');
  });

  test('USDC accepted with an authorised trustline does not block', async () => {
    mockAccepted.value = { XLM: { code: 'XLM' }, USDC: { code: 'USDC', issuer: USDC_ISSUER } };
    mockHorizon.next = healthyAccount({ withUsdc: true });
    const result = await assessWallet(SCHOOL_WALLET);
    expect(result.blockingCode).toBeNull();
  });

  test('XLM-only deployments never ask for a USDC trustline', async () => {
    mockHorizon.next = healthyAccount({ withUsdc: false });
    const result = await assessWallet(SCHOOL_WALLET);
    expect(result.blockingCode).toBeNull();
    expect(result.warnings.map((w) => w.code)).not.toContain('USDC_TRUSTLINE_MISSING');
  });

  test('advisory warnings (weak thresholds) are returned but do not block', async () => {
    const weak = healthyAccount();
    weak.thresholds = { low_threshold: 0, med_threshold: 0, high_threshold: 0 };
    mockHorizon.next = weak;
    const result = await assessWallet(SCHOOL_WALLET);
    expect(result.blockingCode).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain('THRESHOLD_TOO_LOW');
  });

  test('a Horizon outage is reported as unavailable and never blocks', async () => {
    mockHorizon.next = Object.assign(new Error('socket hang up'), { response: { status: 503 } });
    const result = await assessWallet(SCHOOL_WALLET);
    expect(result).toEqual({ status: 'unavailable', health: null, warnings: [], blockingCode: null });
  });
});

describe('issue #1938 — create school uses the evaluator', () => {
  test('creating a USDC-accepting school without a trustline returns 409 USDC_TRUSTLINE_MISSING', async () => {
    mockAccepted.value = { XLM: { code: 'XLM' }, USDC: { code: 'USDC', issuer: USDC_ISSUER } };
    mockHorizon.next = healthyAccount({ withUsdc: false });
    const res = mockRes();

    await schoolController.createSchool(createReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USDC_TRUSTLINE_MISSING' }));
    expect(School.create).not.toHaveBeenCalled();
  });

  test('a healthy wallet is created and the response carries the warnings list', async () => {
    const res = mockRes();
    await schoolController.createSchool(createReq(), res, jest.fn());

    expect(School.create).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  test('an unreachable Horizon does not block creation', async () => {
    mockHorizon.next = new Error('timeout');
    const res = mockRes();
    await schoolController.createSchool(createReq(), res, jest.fn());
    expect(School.create).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a missing account is blocked before the school is written', async () => {
    mockHorizon.next = notFound;
    const res = mockRes();
    await schoolController.createSchool(createReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACCOUNT_NOT_FOUND' }));
    expect(School.create).not.toHaveBeenCalled();
  });
});

describe('issue #1938 — wallet-health endpoint', () => {
  test('returns exactly the warnings the evaluator produces', async () => {
    mockAccepted.value = { XLM: { code: 'XLM' }, USDC: { code: 'USDC', issuer: USDC_ISSUER } };
    mockHorizon.next = healthyAccount({ withUsdc: false });
    School.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ schoolId: 'SCH-1', stellarAddress: SCHOOL_WALLET }) }) });

    const res = mockRes();
    await schoolController.getWalletHealth({ params: { schoolId: 'SCH-1' } }, res, jest.fn());

    const expected = evaluateWalletReadiness(healthyAccount({ withUsdc: false }), {
      acceptedAssets: ['XLM', 'USDC'],
      usdcIssuer: USDC_ISSUER,
    });
    const body = res.json.mock.calls[0][0];
    expect(body.schoolId).toBe('SCH-1');
    expect(body.warnings).toEqual(expected.warnings);
    expect(body.warnings.map((w) => w.code)).toContain('USDC_TRUSTLINE_MISSING');
  });

  test('returns 503 HORIZON_UNAVAILABLE rather than a misleading all-clear', async () => {
    School.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ schoolId: 'SCH-1', stellarAddress: SCHOOL_WALLET }) }) });
    mockHorizon.next = new Error('timeout');
    const res = mockRes();
    await schoolController.getWalletHealth({ params: { schoolId: 'SCH-1' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'HORIZON_UNAVAILABLE' }));
  });

  test('unknown school goes to the error handler as NOT_FOUND', async () => {
    School.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    const next = jest.fn();
    await schoolController.getWalletHealth({ params: { schoolId: 'nope' } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('issue #1938 — daily job publishes school_wallet_warning{code}', () => {
  test('counts schools per code, skips unavailable schools, and zeroes absent codes', async () => {
    mockAccepted.value = { XLM: { code: 'XLM' }, USDC: { code: 'USDC', issuer: USDC_ISSUER } };
    School.find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { schoolId: 'A', stellarAddress: 'GA_A' },
          { schoolId: 'B', stellarAddress: 'GA_B' },
          { schoolId: 'C', stellarAddress: 'GA_C' },
        ],
      }),
    });
    const perAccount = {
      GA_A: healthyAccount({ withUsdc: false }),
      GA_B: healthyAccount({ withUsdc: true }),
      GA_C: null, // unavailable — sends a Horizon error below
    };
    const horizonServer = require('../src/config/stellarConfig').server;
    const original = horizonServer.accounts;
    horizonServer.accounts = () => ({
      accountId: (id) => ({
        call: () => (perAccount[id] === null ? Promise.reject(new Error('timeout')) : Promise.resolve(perAccount[id])),
      }),
    });

    try {
      schoolWalletWarningGauge.reset();
      const summary = await walletHealthScheduler.runWalletHealthCheck();

      expect(summary).toMatchObject({ schools: 3, checked: 2, unavailable: 1 });
      const values = Object.fromEntries((await schoolWalletWarningGauge.get()).values.map((v) => [v.labels.code, v.value]));
      expect(values.USDC_TRUSTLINE_MISSING).toBe(1);
      expect(values.ACCOUNT_NOT_FOUND).toBe(0);
      expect(Object.keys(values)).toEqual(expect.arrayContaining(walletHealthScheduler.REPORTED_CODES));
    } finally {
      horizonServer.accounts = original;
    }
  });

  test('every blocking code is one the scheduler reports', () => {
    for (const code of BLOCKING_CODES) {
      expect(walletHealthScheduler.REPORTED_CODES).toContain(code);
    }
  });
});
