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
 * Check whether an asset (by code and type) is accepted by the system.
 * @param {string} assetCode  e.g. 'XLM', 'USDC'
 * @param {string} assetType  Stellar asset type string ('native', 'credit_alphanum4', …)
 * @returns {{ accepted: boolean, asset: object|null }}
 */
function isAcceptedAsset(assetCode, assetType) {
  const asset = ACCEPTED_ASSETS[assetCode];
  if (!asset) return { accepted: false, asset: null };
  if (asset.type !== assetType) return { accepted: false, asset: null };
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
  CB_FAILURE_THRESHOLD,
  CB_RESET_TIMEOUT_MS,
  CB_HALF_OPEN_SUCCESS_THRESHOLD,
};
