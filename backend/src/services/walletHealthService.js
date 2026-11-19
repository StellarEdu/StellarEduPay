'use strict';

/**
 * Settlement-wallet health checks (#1938).
 *
 * Connects the pure evaluator in walletReadinessService (#1807) to Horizon so
 * that onboarding, rotation, the health endpoint and the daily job all apply
 * the same rules.
 *
 * Blocking vs. advisory:
 *  - ACCOUNT_NOT_FOUND and USDC_TRUSTLINE_MISSING block create/rotate (409). A
 *    wallet in either state cannot receive the payments the school advertises.
 *  - Everything else is advisory and is returned as `warnings`.
 *  - A Horizon timeout or outage never blocks: the check is reported as
 *    `unavailable` and the caller proceeds as it did before this check existed.
 */

const stellarConfig = require('../config/stellarConfig');
const { evaluateWalletReadiness } = require('./walletReadinessService');
const logger = require('../utils/logger').child('WalletHealth');

const HORIZON_TIMEOUT_MS = 3000;
const BLOCKING_CODES = Object.freeze(['ACCOUNT_NOT_FOUND', 'USDC_TRUSTLINE_MISSING']);

async function fetchAccount(stellarAddress) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Horizon check timeout')), HORIZON_TIMEOUT_MS);
  });
  try {
    return await Promise.race([stellarConfig.server.accounts().accountId(stellarAddress).call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evaluate a school's settlement wallet against the deployment's accepted assets.
 *
 * @param {string} stellarAddress
 * @returns {Promise<{
 *   status: 'ok' | 'unavailable',
 *   health: object|null,
 *   warnings: Array<{code: string, message: string}>,
 *   blockingCode: string|null,
 * }>}
 */
async function assessWallet(stellarAddress) {
  let account;
  try {
    account = await fetchAccount(stellarAddress);
  } catch (err) {
    if (err?.response?.status === 404 || err?.status === 404) {
      account = null;
    } else {
      logger.warn('Wallet readiness check skipped: Horizon unavailable', { error: err.message });
      return { status: 'unavailable', health: null, warnings: [], blockingCode: null };
    }
  }

  const health = evaluateWalletReadiness(account, {
    acceptedAssets: Object.keys(stellarConfig.ACCEPTED_ASSETS),
    usdcIssuer: stellarConfig.ACCEPTED_ASSETS.USDC?.issuer,
  });

  const blocking = health.warnings.find((w) => BLOCKING_CODES.includes(w.code));
  return {
    status: 'ok',
    health,
    warnings: health.warnings,
    blockingCode: blocking ? blocking.code : null,
  };
}

module.exports = { assessWallet, BLOCKING_CODES };
