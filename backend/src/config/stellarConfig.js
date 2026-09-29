'use strict';

const StellarSdk = require('@stellar/stellar-sdk');
const config = require('./index');
const {
  getInstance: getFailoverClient,
  CB_FAILURE_THRESHOLD,
  CB_RESET_TIMEOUT_MS,
  CB_HALF_OPEN_SUCCESS_THRESHOLD,
} = require('../services/horizonFailoverClient');

// The failover client manages a prioritized list of Horizon URLs, a circuit
// breaker per endpoint, and health-aware failover.  Callers that need to make
// Horizon calls should prefer `horizonClient.call(server => server.xyz())`
// so failover is automatic.  The `.server` property is kept for backward
// compatibility with code that still accesses `server` directly.
const horizonClient = getFailoverClient();

/**
 * Backward-compatible `server` export.
 * Points to the currently active Horizon.Server instance.
 * Use `horizonClient.call(fn)` for failover-aware calls.
 */
const server = horizonClient.server;

const networkPassphrase = config.IS_TESTNET
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

// In multi-school setup, SCHOOL_WALLET_ADDRESS is optional (only used for migration)
// Each school has its own stellarAddress in the database
const SCHOOL_WALLET = config.SCHOOL_WALLET_ADDRESS || null;

if (SCHOOL_WALLET && !StellarSdk.StrKey.isValidEd25519PublicKey(SCHOOL_WALLET)) {
  throw new Error(
    `[Config] SCHOOL_WALLET_ADDRESS is invalid. ` +
    'Provide a valid Stellar public key (starts with G).'
  );
}

// All known assets
const ALL_ASSETS = {
  XLM: {
    code: 'XLM',
    type: 'native',
    issuer: null,
    displayName: 'Stellar Lumens',
    decimals: 7,
  },
  USDC: {
    code: 'USDC',
    type: 'credit_alphanum4',
    issuer: config.USDC_ISSUER,
    displayName: 'USD Coin',
    decimals: 7,
  },
};

// Only the asset configured via ACCEPTED_ASSET env var (default: XLM)
const configuredAsset = ALL_ASSETS[config.ACCEPTED_ASSET];
if (!configuredAsset) {
  throw new Error(
    `[Config] ACCEPTED_ASSET "${config.ACCEPTED_ASSET}" is not supported. Valid values: ${Object.keys(ALL_ASSETS).join(', ')}`
  );
}

const ACCEPTED_ASSETS = { [configuredAsset.code]: configuredAsset };

/**
 * Check whether an asset (by code, type, and — for credit assets — issuer) is
 * accepted by the system.
 *
 * Issuer validation (#841) is a security boundary, not a nicety: a non-native
 * asset is only as trustworthy as its issuer. The asset code "USDC" is just a
 * 4-character label that ANY account can mint. Without pinning the issuer, a
 * worthless token coded "USDC" from an attacker's account would be credited at
 * face value — direct financial fraud. So for credit assets we require the
 * on-chain `asset_issuer` to exactly match the issuer pinned for the active
 * network in config (Circle's canonical USDC issuer). Native XLM has no issuer
 * and must not carry one.
 *
 * @param {string} assetCode    e.g. 'XLM', 'USDC'
 * @param {string} assetType    Stellar asset type ('native', 'credit_alphanum4', …)
 * @param {string|null} [assetIssuer]  on-chain issuer account (G...) for credit assets
 * @returns {{ accepted: boolean, asset: object|null, reason?: string }}
 */
function isAcceptedAsset(assetCode, assetType, assetIssuer = null) {
  const asset = ACCEPTED_ASSETS[assetCode];
  if (!asset) return { accepted: false, asset: null, reason: 'unsupported_code' };
  if (asset.type !== assetType) return { accepted: false, asset: null, reason: 'type_mismatch' };

  // Native asset (XLM): no issuer exists on-chain. Reject any spurious issuer.
  if (asset.type === 'native') {
    if (assetIssuer) return { accepted: false, asset: null, reason: 'unexpected_issuer' };
    return { accepted: true, asset };
  }

  // Credit asset (e.g. USDC): the pinned issuer must be configured AND must
  // exactly match the on-chain asset_issuer.
  if (!asset.issuer) {
    return { accepted: false, asset: null, reason: 'issuer_not_configured' };
  }
  if (assetIssuer !== asset.issuer) {
    return { accepted: false, asset: null, reason: 'issuer_mismatch' };
  }
  return { accepted: true, asset };
}

/**
 * Resolve a Stellar SDK Asset from an accepted-asset code.
 * @param {string} assetCode
 * @returns {StellarSdk.Asset|null}
 */
function resolveAsset(assetCode) {
  const cfg = ACCEPTED_ASSETS[assetCode];
  if (!cfg) return null;
  if (cfg.type === 'native') return StellarSdk.Asset.native();
  return new StellarSdk.Asset(cfg.code, cfg.issuer);
}

const CONFIRMATION_THRESHOLD = config.CONFIRMATION_THRESHOLD;
const FINALIZATION_THRESHOLD = config.FINALIZATION_THRESHOLD;

/**
 * Classify a Horizon `submitTransaction` error as either a definitive failure
 * or an ambiguous outcome (#1562).
 *
 * Horizon's synchronous submit endpoint returns 504 Timeout when the
 * transaction was accepted into the queue but not yet included in a ledger
 * within Horizon's timeout. Stellar's documentation is explicit that a timeout
 * is NOT a failure: the transaction may still succeed and the client must
 * re-check by hash (or resubmit the identical envelope, which is idempotent).
 * Network errors between the backend and Horizon have the same ambiguity.
 *
 * Only a definitive rejection — HTTP 400 carrying `extras.result_codes`
 * (e.g. tx_bad_seq, tx_insufficient_balance, op_no_trust) — proves the
 * transaction was not applied. Everything else (504, 5xx, network errors,
 * and tx_too_late before timeBounds expiry) must be treated as ambiguous so
 * the caller keeps the payment SUBMITTED and lets the poller resolve it by
 * hash.
 *
 * @param {Error & { response?: { status?: number, data?: any } }} err
 * @returns {{ definitive: boolean, resultCode: string|null, reason: string }}
 */
function classifySubmitError(err) {
  const status = err && err.response && err.response.status;
  const data = err && err.response && err.response.data;
  const resultCodes = data && data.extras && data.extras.result_codes;
  const txResultCode = resultCodes && resultCodes.transaction;

  // Definitive: Horizon rejected the envelope outright (HTTP 400) and told us
  // why via result_codes. The transaction was not applied.
  if (status === 400 && txResultCode) {
    return {
      definitive: true,
      resultCode: txResultCode,
      reason: txResultCode,
    };
  }

  // Ambiguous: 504 timeout, any 5xx, network errors, or a 400 without
  // result_codes. The transaction may still be applied — do not mark FAILED.
  const reason =
    (data && data.detail) ||
    (err && err.message) ||
    'ambiguous_horizon_outcome';

  return {
    definitive: false,
    resultCode: txResultCode || null,
    reason,
  };
}

module.exports = {
  server,
  horizonClient,
  networkPassphrase,
  SCHOOL_WALLET,
  StellarSdk,
  ACCEPTED_ASSETS,
  CONFIRMATION_THRESHOLD,
  FINALIZATION_THRESHOLD,
  isAcceptedAsset,
  resolveAsset,
  classifySubmitError,
  CB_FAILURE_THRESHOLD,
  CB_RESET_TIMEOUT_MS,
  CB_HALF_OPEN_SUCCESS_THRESHOLD,
};
