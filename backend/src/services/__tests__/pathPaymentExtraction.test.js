'use strict';

/**
 * Tests for #1557 — path-payment crediting.
 *
 * extractValidPayment must accept path_payment_strict_send and
 * path_payment_strict_receive operations, not only plain `payment` ops.
 * For all three types Horizon surfaces the destination asset/amount on the
 * same fields (`to`, `asset_type`, `asset_code`, `asset_issuer`, `amount`).
 */

const {
  SCHOOL_WALLET,
  PARENT_WALLET,
  USDC_ISSUER,
  pathPaymentStrictSend,
  pathPaymentStrictReceive,
  pathPaymentOtherDestination,
  pathPaymentUnacceptedAsset,
  asTransaction,
} = require('./fixtures/pathPayments');

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../config/stellarConfig', () => ({
  server: {},
  isAcceptedAsset: jest.fn((code, type, issuer) => {
    // Accept native XLM and USDC from the fixture issuer only
    if (code === 'XLM' && type === 'native' && !issuer) return { accepted: true };
    if (
      code === 'USDC' &&
      type === 'credit_alphanum4' &&
      issuer === require('./fixtures/pathPayments').USDC_ISSUER
    ) {
      return { accepted: true };
    }
    return { accepted: false };
  }),
  CONFIRMATION_THRESHOLD: 3,
  FINALIZATION_THRESHOLD: 10,
}));

jest.mock('../../utils/stellarMemo', () => ({
  SUPPORTED_MEMO_TYPES: ['text', 'id', 'hash'],
  normalizeMemoType: (type) => (type === 'text' ? 'MEMO_TEXT' : null),
  decodeMemoToCanonical: (memo) => memo || null,
}));

jest.mock('../../utils/withStellarRetry', () => ({
  withStellarRetry: (_fn, _opts) => {
    // For the operations() call, return the operations attached to the tx
    // The test builds tx with an `operations` array; we simulate the Horizon
    // records wrapper here.
    return Promise.resolve({ records: _fn._testOps || [] });
  },
}));

// Override withStellarRetry so we can thread the operations through
const { withStellarRetry } = require('../../utils/withStellarRetry');

const { extractValidPayment } = require('../stellarService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Horizon transaction record with the given operation.
 * Attaches the operation so our withStellarRetry mock can find it.
 */
function buildTxWithOp(op, overrides = {}) {
  const tx = asTransaction(op, overrides);
  // Attach a callable `operations` that our mock intercepts via the closure.
  tx.operations = function () {
    return Promise.resolve({ records: [op] });
  };
  // Patch withStellarRetry to forward the real promise from tx.operations()
  withStellarRetry.mockImplementation((fn) => fn());
  return tx;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('extractValidPayment — path-payment support (#1557)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: withStellarRetry passes through to the function
    withStellarRetry.mockImplementation((fn) => fn());
  });

  it('accepts path_payment_strict_send arriving at the school wallet', async () => {
    const tx = buildTxWithOp(pathPaymentStrictSend);
    const result = await extractValidPayment(tx, SCHOOL_WALLET);

    expect(result).not.toBeNull();
    expect(result.payOp.type).toBe('path_payment_strict_send');
    expect(result.payOp.to).toBe(SCHOOL_WALLET);
    expect(result.asset.assetCode).toBe('USDC');
    expect(result.memo).toBe('SCHOOL-12345');
  });

  it('accepts path_payment_strict_receive arriving at the school wallet', async () => {
    const tx = buildTxWithOp(pathPaymentStrictReceive);
    const result = await extractValidPayment(tx, SCHOOL_WALLET);

    expect(result).not.toBeNull();
    expect(result.payOp.type).toBe('path_payment_strict_receive');
    expect(result.payOp.to).toBe(SCHOOL_WALLET);
    expect(result.asset.assetCode).toBe('USDC');
  });

  it('rejects a path payment whose destination is not the school wallet', async () => {
    const tx = buildTxWithOp(pathPaymentOtherDestination);
    const result = await extractValidPayment(tx, SCHOOL_WALLET);
    expect(result).toBeNull();
  });

  it('rejects a path payment delivering an asset the school does not accept', async () => {
    const tx = buildTxWithOp(pathPaymentUnacceptedAsset);
    const result = await extractValidPayment(tx, SCHOOL_WALLET);
    expect(result).toBeNull();
  });

  it('still accepts a plain `payment` operation as before', async () => {
    const plainPaymentOp = {
      ...pathPaymentStrictSend,
      type: 'payment',
      type_i: 1,
      transaction_hash: 'txhashplainpayment000000000000000000000000000000000000000000000001',
    };
    const tx = buildTxWithOp(plainPaymentOp);
    const result = await extractValidPayment(tx, SCHOOL_WALLET);

    expect(result).not.toBeNull();
    expect(result.payOp.type).toBe('payment');
  });

  it('returns null when the transaction was not successful', async () => {
    const tx = buildTxWithOp(pathPaymentStrictSend, { successful: false });
    const result = await extractValidPayment(tx, SCHOOL_WALLET);
    expect(result).toBeNull();
  });

  it('returns null when the memo is missing', async () => {
    const tx = buildTxWithOp(pathPaymentStrictSend, {
      memo_type: 'none',
      memo: undefined,
    });
    const result = await extractValidPayment(tx, SCHOOL_WALLET);
    expect(result).toBeNull();
  });
});
