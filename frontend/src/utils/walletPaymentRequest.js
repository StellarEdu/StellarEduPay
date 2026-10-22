import { validateStellarAmount } from './stellarAmount';
import { encodeMemo, normalizeMemoType } from './stellarMemo';

/**
 * Helpers for the "Pay with wallet" flow (#1808).
 *
 * These build the request a browser wallet (Freighter, xBull, Lobstr, …) needs
 * to sign a payment, and decide whether the "Pay with wallet" button may be
 * enabled. They do no network I/O and never hold a key.
 */

export const NETWORK_PASSPHRASES = Object.freeze({
  TESTNET: 'Test SDF Network ; September 2015',
  PUBLIC: 'Public Global Stellar Network ; September 2015',
});

/**
 * @param {object} params
 * @param {string} params.destination - school account (G...)
 * @param {string|number} params.amount - amount in the asset's units
 * @param {string} params.memo - canonical intent memo
 * @param {string} [params.memoType='MEMO_TEXT']
 * @param {string} [params.assetCode='XLM']
 * @param {string} [params.assetIssuer] - required for non-native assets
 * @param {string} params.networkPassphrase - from /api/public-config
 * @returns {{destination: string, amount: string, memo: string, memoType: string,
 *            assetCode: string, assetIssuer: string|null, networkPassphrase: string}}
 * @throws {Error} when a field is missing or invalid
 */
export function buildWalletPaymentRequest({
  destination,
  amount,
  memo,
  memoType = 'MEMO_TEXT',
  assetCode = 'XLM',
  assetIssuer = null,
  networkPassphrase,
}) {
  if (!destination) {
    throw new Error('Destination wallet address is required');
  }
  if (!networkPassphrase) {
    throw new Error('Network passphrase is required');
  }

  const amountCheck = validateStellarAmount(amount);
  if (!amountCheck.valid) {
    throw new Error(`Valid payment amount is required: ${amountCheck.error}`);
  }

  const type = normalizeMemoType(memoType);
  const isNative = assetCode === 'XLM' || assetCode === 'native';
  if (!isNative && !assetIssuer) {
    throw new Error(`An issuer is required for ${assetCode}`);
  }

  return {
    destination,
    amount: amountCheck.normalized,
    memo: encodeMemo(memo, type),
    memoType: type,
    assetCode: isNative ? 'XLM' : assetCode,
    assetIssuer: isNative ? null : assetIssuer,
    networkPassphrase,
  };
}

/**
 * The wallet button stays disabled unless the wallet is on the same network as
 * the backend. Paying on the wrong network would send funds nowhere useful.
 *
 * @param {string|null|undefined} walletPassphrase - passphrase reported by the wallet
 * @param {string|null|undefined} expectedPassphrase - passphrase from /api/public-config
 * @returns {boolean}
 */
export function isWalletOnExpectedNetwork(walletPassphrase, expectedPassphrase) {
  return Boolean(walletPassphrase) && Boolean(expectedPassphrase) && walletPassphrase === expectedPassphrase;
}
