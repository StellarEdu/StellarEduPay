/**
 * Tests for issue #1808 — "Pay with wallet" request building and network gating.
 */

import {
  buildWalletPaymentRequest,
  isWalletOnExpectedNetwork,
  NETWORK_PASSPHRASES,
} from '../walletPaymentRequest';

const DEST = 'GSCHOOLACCOUNTADDRESSEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const ISSUER = 'GISSUERUSDCADDRESSEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

describe('issue #1808 — buildWalletPaymentRequest', () => {
  test('builds a native XLM request with the canonical amount and memo', () => {
    const request = buildWalletPaymentRequest({
      destination: DEST,
      amount: '100',
      memo: 'STU-ABC123',
      networkPassphrase: NETWORK_PASSPHRASES.TESTNET,
    });
    expect(request).toEqual({
      destination: DEST,
      amount: '100.0000000',
      memo: 'STU-ABC123',
      memoType: 'MEMO_TEXT',
      assetCode: 'XLM',
      assetIssuer: null,
      networkPassphrase: NETWORK_PASSPHRASES.TESTNET,
    });
  });

  test('carries the issuer for a non-native asset such as USDC', () => {
    const request = buildWalletPaymentRequest({
      destination: DEST,
      amount: '25.5',
      memo: 'STU-ABC123',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      networkPassphrase: NETWORK_PASSPHRASES.PUBLIC,
    });
    expect(request).toMatchObject({ assetCode: 'USDC', assetIssuer: ISSUER, amount: '25.5000000' });
  });

  test('refuses a non-native asset without an issuer', () => {
    expect(() => buildWalletPaymentRequest({
      destination: DEST,
      amount: '10',
      memo: 'STU-ABC123',
      assetCode: 'USDC',
      networkPassphrase: NETWORK_PASSPHRASES.TESTNET,
    })).toThrow(/issuer is required for USDC/);
  });

  test('refuses sub-stroop amounts', () => {
    expect(() => buildWalletPaymentRequest({
      destination: DEST,
      amount: '0.00000001',
      memo: 'STU-ABC123',
      networkPassphrase: NETWORK_PASSPHRASES.TESTNET,
    })).toThrow(/Valid payment amount is required/);
  });

  test('refuses a missing destination or network passphrase', () => {
    expect(() => buildWalletPaymentRequest({ amount: '1', memo: 'x', networkPassphrase: NETWORK_PASSPHRASES.TESTNET }))
      .toThrow(/Destination wallet address is required/);
    expect(() => buildWalletPaymentRequest({ destination: DEST, amount: '1', memo: 'x' }))
      .toThrow(/Network passphrase is required/);
  });
});

describe('issue #1808 — isWalletOnExpectedNetwork', () => {
  test('is true only when the wallet and backend use the same passphrase', () => {
    expect(isWalletOnExpectedNetwork(NETWORK_PASSPHRASES.TESTNET, NETWORK_PASSPHRASES.TESTNET)).toBe(true);
    expect(isWalletOnExpectedNetwork(NETWORK_PASSPHRASES.PUBLIC, NETWORK_PASSPHRASES.TESTNET)).toBe(false);
  });

  test('is false when either side is missing, so the button stays disabled', () => {
    expect(isWalletOnExpectedNetwork(null, NETWORK_PASSPHRASES.TESTNET)).toBe(false);
    expect(isWalletOnExpectedNetwork(NETWORK_PASSPHRASES.TESTNET, undefined)).toBe(false);
  });
});
