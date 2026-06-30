'use strict';

/**
 * #840 — Reorg / failed-transaction handling distinct from successful ledger
 *        inclusion, plus #841 wrong-asset rejection in the credit path.
 *
 * A Stellar transaction can be included in a ledger yet have
 * `successful === false`. Such a transaction must never be credited. Likewise a
 * payment carrying a USDC-coded asset from the wrong issuer must be rejected.
 * These tests drive extractValidPayment against fixtures for: a failed-but-
 * included tx, a wrong-issuer USDC tx, a wrong-destination tx, and the happy
 * path — asserting only a successful payment to the wallet with the pinned
 * asset is accepted.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-for-extract-valid-payment-suite-1234567890';

const WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_GOOD = 'GBUSDCGOODISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USDC_BAD = 'GBUSDCBADISSUERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Mock stellarConfig so we control the pinned USDC issuer and accepted asset
// without loading the real SDK/network layer.
jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {},
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 10,
  ACCEPTED_ASSETS: {
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GBUSDCGOODISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  },
  // Real-shaped issuer validation: USDC only from the pinned good issuer.
  isAcceptedAsset: (code, type, issuer) => {
    if (code !== 'USDC' || type !== 'credit_alphanum4') return { accepted: false, asset: null };
    if (issuer !== 'GBUSDCGOODISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') {
      return { accepted: false, asset: null, reason: 'issuer_mismatch' };
    }
    return { accepted: true, asset: { code, type } };
  },
}));

// @stellar/stellar-sdk's Operation is only used by normalizeAmount; stub it.
jest.mock('@stellar/stellar-sdk', () => ({
  Operation: { _fromXDRAmount: (s) => (parseInt(s, 10) / 1e7).toFixed(7) },
}), { virtual: true });

jest.mock('../backend/src/models/paymentModel', () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/studentModel', () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/paymentIntentModel', () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/services/transactionService', () => ({ savePayment: jest.fn() }));
jest.mock('../backend/src/utils/withStellarRetry', () => ({
  withStellarRetry: (fn) => fn(),
  classifyHorizonError: (e) => e,
}));

const { extractValidPayment } = require('../backend/src/services/stellarService');

function makeTx({ successful = true, memoType = 'text', memo = 'STU001', ops = [] }) {
  return {
    hash: 'TXHASH',
    successful,
    memo_type: memoType,
    memo,
    operations: async () => ({ records: ops }),
  };
}

const goodOp = {
  type: 'payment',
  to: WALLET,
  from: 'GSENDER',
  amount: '100.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: USDC_GOOD,
};

describe('extractValidPayment — failed-tx & asset validation (#840/#841)', () => {
  test('rejects a failed-but-included transaction (successful=false)', async () => {
    const tx = makeTx({ successful: false, ops: [goodOp] });
    expect(await extractValidPayment(tx, WALLET)).toBeNull();
  });

  test('rejects a transaction missing the success flag', async () => {
    const tx = makeTx({ ops: [goodOp] });
    delete tx.successful; // successful === undefined
    expect(await extractValidPayment(tx, WALLET)).toBeNull();
  });

  test('rejects USDC from a non-canonical issuer (fake token)', async () => {
    const tx = makeTx({ ops: [{ ...goodOp, asset_issuer: USDC_BAD }] });
    expect(await extractValidPayment(tx, WALLET)).toBeNull();
  });

  test('rejects a payment to the wrong destination', async () => {
    const tx = makeTx({ ops: [{ ...goodOp, to: 'GSOMEONEELSE' }] });
    expect(await extractValidPayment(tx, WALLET)).toBeNull();
  });

  test('rejects a non-payment operation (e.g. create_account)', async () => {
    const tx = makeTx({ ops: [{ type: 'create_account', to: WALLET, asset_type: 'native' }] });
    expect(await extractValidPayment(tx, WALLET)).toBeNull();
  });

  test('accepts a successful payment to the wallet with the pinned asset', async () => {
    const tx = makeTx({ ops: [goodOp] });
    const valid = await extractValidPayment(tx, WALLET);
    expect(valid).not.toBeNull();
    expect(valid.memo).toBe('STU001');
    expect(valid.asset.assetCode).toBe('USDC');
    expect(valid.asset.assetIssuer).toBe(USDC_GOOD);
  });
});
