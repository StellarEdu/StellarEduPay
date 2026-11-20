'use strict';

/**
 * Per-school accepted assets (#1993).
 *
 * The platform-wide ACCEPTED_ASSETS list says what the deployment *can* handle;
 * it says nothing about what a given school wallet can actually receive. A
 * school that never opened a USDC trustline cannot be credited USDC, so
 * advertising USDC in the pay UI produces payments that can never be matched.
 *
 * The effective list is therefore:
 *   school.acceptedAssets (or the platform default when unset)
 *     ∩ assets the school wallet holds a trustline for (XLM is always native).
 */

const stellarConfig = require('../config/stellarConfig');
const logger = require('../utils/logger').child('SchoolAssets');

const HORIZON_TIMEOUT_MS = 3000;

function platformAssetCodes() {
  return Object.keys(stellarConfig.ACCEPTED_ASSETS);
}

/**
 * Asset codes the school advertises. Falls back to the platform list when the
 * school has no explicit configuration.
 */
function declaredAssetCodes(school) {
  const declared = Array.isArray(school?.acceptedAssets) ? school.acceptedAssets : [];
  const codes = declared
    .map((code) => String(code || '').trim().toUpperCase())
    .filter((code) => platformAssetCodes().includes(code));
  return codes.length > 0 ? codes : platformAssetCodes();
}

/**
 * Asset codes the school wallet can actually receive, derived from its Horizon
 * balances. Returns null when Horizon is unavailable so callers can fall back
 * to the declared list instead of blocking payments on an outage.
 */
async function walletAssetCodes(stellarAddress) {
  if (!stellarAddress) return null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Horizon check timeout')), HORIZON_TIMEOUT_MS);
  });
  try {
    const account = await Promise.race([
      stellarConfig.server.accounts().accountId(stellarAddress).call(),
      timeout,
    ]);
    const codes = new Set(['XLM']);
    for (const balance of account?.balances || []) {
      if (balance.asset_type === 'native') continue;
      if (balance.asset_code) codes.add(balance.asset_code.toUpperCase());
    }
    return codes;
  } catch (err) {
    logger.warn('Could not read school wallet trustlines', {
      stellarAddress,
      error: err.message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the assets a school can actually receive.
 *
 * @param {object} school  School document (needs stellarAddress, acceptedAssets)
 * @returns {Promise<{
 *   assets: Array<{code: string, type: string, displayName: string, issuer: string|null}>,
 *   excluded: Array<{code: string, reason: string, message: string}>,
 * }>}
 */
async function resolveSchoolAssets(school) {
  const declared = declaredAssetCodes(school);
  const walletCodes = await walletAssetCodes(school?.stellarAddress);

  const assets = [];
  const excluded = [];
  for (const code of declared) {
    const cfg = stellarConfig.ACCEPTED_ASSETS[code];
    if (!cfg) continue;
    if (walletCodes && !walletCodes.has(code)) {
      excluded.push({
        code,
        reason: 'TRUSTLINE_MISSING',
        message: `The school wallet has no ${code} trustline, so it cannot receive ${code} payments.`,
      });
      continue;
    }
    assets.push({
      code: cfg.code,
      type: cfg.type,
      displayName: cfg.displayName,
      issuer: cfg.issuer ?? null,
    });
  }

  return { assets, excluded };
}

/**
 * Whether a school accepts a given asset code (declared ∩ trustline).
 * Horizon outages fall back to the declared list.
 */
async function schoolAcceptsAsset(school, assetCode) {
  const code = String(assetCode || '').trim().toUpperCase();
  if (!code) return false;
  const { assets } = await resolveSchoolAssets(school);
  return assets.some((a) => a.code === code);
}

module.exports = {
  declaredAssetCodes,
  walletAssetCodes,
  resolveSchoolAssets,
  schoolAcceptsAsset,
};
