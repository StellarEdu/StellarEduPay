'use strict';

/**
 * School wallet readiness and security evaluation (#1807).
 *
 * Pure function over a Horizon account record: no network I/O, so the same
 * rules can run at onboarding, on a schedule, or in tests.
 *
 * Returns the wallet-health shape proposed in #1807 with a `warnings` list
 * whose codes are stable identifiers for dashboards and alerts.
 */

const Decimal = require('decimal.js');

const BASE_RESERVE_XLM = new Decimal('0.5');
const DEFAULT_MIN_HEADROOM_XLM = new Decimal('1');
const RECOMMENDED_MED_THRESHOLD = 2;

const WARNING_CODES = Object.freeze({
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  USDC_TRUSTLINE_MISSING: 'USDC_TRUSTLINE_MISSING',
  USDC_NOT_AUTHORIZED: 'USDC_NOT_AUTHORIZED',
  USDC_LIMIT_TOO_LOW: 'USDC_LIMIT_TOO_LOW',
  LOW_RESERVE_HEADROOM: 'LOW_RESERVE_HEADROOM',
  THRESHOLD_TOO_LOW: 'THRESHOLD_TOO_LOW',
  UNKNOWN_SIGNER: 'UNKNOWN_SIGNER',
  MEMO_NOT_REQUIRED: 'MEMO_NOT_REQUIRED',
});

function decodeDataEntry(data, key) {
  const raw = data && data[key];
  if (typeof raw !== 'string') return null;
  return Buffer.from(raw, 'base64').toString('utf8');
}

function findUsdcTrustline(balances, usdcIssuer) {
  return (balances || []).find(
    (b) => b.asset_type !== 'native' && b.asset_code === 'USDC' && b.asset_issuer === usdcIssuer,
  ) || null;
}

/**
 * @param {object|null} account - Horizon account record, or null if not found
 * @param {object} options
 * @param {string[]} [options.acceptedAssets=[]] - asset codes the school advertises, e.g. ['XLM', 'USDC']
 * @param {string} [options.usdcIssuer] - pinned USDC issuer address
 * @param {string} [options.minUsdcLimit] - minimum trustline limit in USDC; omit to skip the check
 * @param {string[]} [options.knownSigners=[]] - signer keys the school has approved
 * @param {string} [options.minHeadroomXlm='1'] - reserve headroom below which a warning is raised
 * @returns {object} wallet health report
 */
function evaluateWalletReadiness(account, options = {}) {
  const {
    acceptedAssets = [],
    usdcIssuer,
    minUsdcLimit,
    knownSigners = [],
    minHeadroomXlm = DEFAULT_MIN_HEADROOM_XLM,
  } = options;

  if (!account) {
    return {
      exists: false,
      balanceXLM: null,
      reserveHeadroomXLM: null,
      trustlines: {},
      signers: [],
      thresholds: null,
      memoRequired: false,
      homeDomain: null,
      warnings: [{ code: WARNING_CODES.ACCOUNT_NOT_FOUND, message: 'School account does not exist on the network.' }],
    };
  }

  const warnings = [];
  const native = (account.balances || []).find((b) => b.asset_type === 'native');
  const balanceXLM = new Decimal(native ? native.balance : '0');
  const subentries = Number(account.subentry_count || 0);
  const minimumBalance = BASE_RESERVE_XLM.times(2 + subentries);
  const reserveHeadroom = balanceXLM.minus(minimumBalance);
  if (reserveHeadroom.lessThan(new Decimal(minHeadroomXlm))) {
    warnings.push({
      code: WARNING_CODES.LOW_RESERVE_HEADROOM,
      message: `Only ${reserveHeadroom.toFixed(7)} XLM above the base reserve; a new trustline needs 0.5 XLM.`,
    });
  }

  const trustlines = {};
  if (acceptedAssets.includes('USDC')) {
    const line = findUsdcTrustline(account.balances, usdcIssuer);
    trustlines.USDC = {
      present: Boolean(line),
      limit: line ? line.limit : null,
      authorized: line ? Boolean(line.is_authorized) : false,
    };
    if (!line) {
      warnings.push({
        code: WARNING_CODES.USDC_TRUSTLINE_MISSING,
        message: 'USDC is accepted but the school account has no trustline to the pinned issuer; USDC payments would fail.',
      });
    } else {
      if (!line.is_authorized) {
        warnings.push({ code: WARNING_CODES.USDC_NOT_AUTHORIZED, message: 'The USDC trustline is not authorized to receive funds.' });
      }
      if (minUsdcLimit !== undefined && new Decimal(line.limit).lessThan(new Decimal(minUsdcLimit))) {
        warnings.push({
          code: WARNING_CODES.USDC_LIMIT_TOO_LOW,
          message: `The USDC trustline limit ${line.limit} is below the required ${minUsdcLimit}.`,
        });
      }
    }
  }

  const thresholds = {
    low_threshold: account.thresholds ? account.thresholds.low_threshold : 0,
    med_threshold: account.thresholds ? account.thresholds.med_threshold : 0,
    high_threshold: account.thresholds ? account.thresholds.high_threshold : 0,
  };
  if (thresholds.med_threshold < RECOMMENDED_MED_THRESHOLD) {
    warnings.push({
      code: WARNING_CODES.THRESHOLD_TOO_LOW,
      message: `med_threshold is ${thresholds.med_threshold}; a single key can move funds. Use at least ${RECOMMENDED_MED_THRESHOLD}.`,
    });
  }

  const signers = (account.signers || []).map((s) => ({ key: s.key, weight: s.weight, type: s.type }));
  const approved = new Set([account.account_id, ...knownSigners]);
  for (const signer of signers) {
    if (signer.weight > 0 && !approved.has(signer.key)) {
      warnings.push({
        code: WARNING_CODES.UNKNOWN_SIGNER,
        message: `Unrecognised signer ${signer.key} can authorise transactions on this account.`,
      });
    }
  }

  const memoRequired = decodeDataEntry(account.data_attr || account.data, 'config.memo_required') === '1';
  if (!memoRequired) {
    warnings.push({
      code: WARNING_CODES.MEMO_NOT_REQUIRED,
      message: 'config.memo_required is not set; memo-less payments to this account cannot be rejected by wallets.',
    });
  }

  return {
    exists: true,
    balanceXLM: balanceXLM.toFixed(7),
    reserveHeadroomXLM: reserveHeadroom.toFixed(7),
    trustlines,
    signers,
    thresholds,
    memoRequired,
    homeDomain: account.home_domain || null,
    warnings,
  };
}

module.exports = { evaluateWalletReadiness, WARNING_CODES };
