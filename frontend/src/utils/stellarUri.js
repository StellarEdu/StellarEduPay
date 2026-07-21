import { validateStellarAmount } from './stellarAmount';
import { encodeMemo, isEncodableMemo, normalizeMemoType } from './stellarMemo';

/**
 * Generate a Stellar SEP-0007 payment URI
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * @param {Object} params - Payment parameters
 * @param {string} params.destination - Stellar wallet address (G...)
 * @param {string|number} params.amount - Payment amount in XLM
 * @param {string} params.memo - Payment memo (canonical intent memo, or free text)
 * @param {string} [params.memoType='MEMO_TEXT'] - MEMO_TEXT, MEMO_ID or MEMO_HASH
 * @param {string} [params.assetCode='XLM'] - Asset code (XLM, USDC, etc.)
 * @param {string} [params.assetIssuer] - Asset issuer (required for non-native assets)
 * @returns {string} Stellar payment URI
 */
export function generateStellarPaymentUri({
  destination,
  amount,
  memo,
  memoType = 'MEMO_TEXT',
  assetCode = 'XLM',
  assetIssuer = null,
}) {
  if (!destination) {
    throw new Error('Destination wallet address is required');
  }

  // Validate in stroop space using the same rules as the backend (#1123).
  // `parseFloat(amount) > 0` used to be enough here, which let sub-stroop
  // amounts (0.00000001) and scientific notation (1e-8) into the QR code — both
  // parse as positive numbers but are not amounts a Stellar wallet or the
  // backend will honour.
  const amountCheck = validateStellarAmount(amount);
  if (!amountCheck.valid) {
    throw new Error(`Valid payment amount is required: ${amountCheck.error}`);
  }

  const params = new URLSearchParams();
  params.append('destination', destination);
  // Emit the canonical 7-decimal form so the wallet, the QR code and the
  // backend all see the identical value.
  params.append('amount', amountCheck.normalized);

  if (memo) {
    // Throws for a memo that cannot be represented in the requested type,
    // rather than silently emitting a URI the backend could never match back
    // to an intent.
    const type = normalizeMemoType(memoType);
    params.append('memo', encodeMemo(memo, type));
    params.append('memo_type', type);
  }

  // For non-native assets, include asset code and issuer
  if (assetCode !== 'XLM' && assetCode !== 'native') {
    params.append('asset_code', assetCode);
    if (assetIssuer) {
      params.append('asset_issuer', assetIssuer);
    }
  }

  return `web+stellar:pay?${params.toString()}`;
}

/**
 * Which memo types a given memo can be offered in.
 * Free-text memos (e.g. a raw student ID) have no numeric equivalent, so they
 * are MEMO_TEXT only.
 *
 * @param {string} memo
 * @returns {string[]} Supported SEP-0007 memo types
 */
export function availableMemoTypes(memo) {
  return isEncodableMemo(memo) ? ['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH'] : ['MEMO_TEXT'];
}
