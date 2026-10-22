'use strict';

/**
 * Regression tests for issue #1756:
 * The poller must validate payments against the detected asset code
 * (asset.assetCode) and must pass a string asset code plus the school's
 * local currency to captureFiatSnapshot.
 */

jest.mock('../../config/database', () => ({
  transaction: jest.fn(),
  query: jest.fn(),
}));

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../stellarService', () => ({
  detectAsset: jest.fn(),
  verifyTransaction: jest.fn(),
}));

jest.mock('../paymentLimitsService', () => ({
  validatePaymentAmount: jest.fn(),
}));

jest.mock('../fiatSnapshotService', () => ({
  captureFiatSnapshot: jest.fn(),
}));

const db = require('../../config/database');
const stellarService = require('../stellarService');
const { validatePaymentAmount } = require('../paymentLimitsService');
const { captureFiatSnapshot } = require('../fiatSnapshotService');
const transactionPollingService = require('../transactionPollingService');

describe('transactionPollingService.processTransaction (#1756)', () => {
  const school = {
    id: 42,
    stellar_account: 'GSCHOOLACCOUNT',
    localCurrency: 'NGN',
  };

  const usdcAsset = {
    assetCode: 'USDC',
    assetType: 'credit_alphanum4',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  };

  const payment = {
    id: 'tx-usdc-1',
    source_account: 'GSENDERACCOUNT',
    to: 'GSCHOOLACCOUNT',
    amount: '250.00',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: usdcAsset.assetIssuer,
    memo: 'tuition',
    created_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    stellarService.detectAsset.mockReturnValue(usdcAsset);
    stellarService.verifyTransaction.mockResolvedValue({ valid: true });

    validatePaymentAmount.mockResolvedValue({ valid: true });
    captureFiatSnapshot.mockResolvedValue({
      amount: 250,
      currency: 'NGN',
      rate: 1500,
      fiatAmount: 375000,
    });

    db.query.mockResolvedValue({ rows: [school], rowCount: 1 });
    db.transaction.mockImplementation(async (cb) => cb({ query: db.query }));
  });

  it('validates USDC payments against USDC limits', async () => {
    await transactionPollingService.processTransaction(payment, school);

    expect(validatePaymentAmount).toHaveBeenCalledTimes(1);
    const [, options] = validatePaymentAmount.mock.calls[0];
    expect(options.asset).toBe('USDC');
    expect(options.asset).not.toBeUndefined();
  });

  it('captures a fiat snapshot with a string asset code and the school currency', async () => {
    await transactionPollingService.processTransaction(payment, school);

    expect(captureFiatSnapshot).toHaveBeenCalledTimes(1);
    const [amount, assetCode, currency] = captureFiatSnapshot.mock.calls[0];
    expect(amount).toBe(payment.amount);
    expect(assetCode).toBe('USDC');
    expect(typeof assetCode).toBe('string');
    expect(currency).toBe('NGN');
  });

  it('falls back to XLM and USD when asset code or local currency is missing', async () => {
    stellarService.detectAsset.mockReturnValue({ assetCode: null });

    await transactionPollingService.processTransaction(payment, {
      ...school,
      localCurrency: undefined,
    });

    const [, assetCode, currency] = captureFiatSnapshot.mock.calls[0];
    expect(assetCode).toBe('XLM');
    expect(currency).toBe('USD');
  });
});
