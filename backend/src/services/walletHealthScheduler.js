'use strict';

/**
 * Daily wallet-health sweep (#1938). Leader-only, so it runs once per cluster.
 *
 * Re-checks every active school's settlement wallet and publishes
 * `school_wallet_warning{code}` = number of schools currently raising that code.
 * Schools whose check was unavailable (Horizon down) are left out of the counts
 * rather than being reported as healthy.
 */

const School = require('../models/schoolModel');
const { schoolWalletWarningGauge } = require('../metrics');
const { assessWallet } = require('./walletHealthService');
const logger = require('../utils/logger').child('WalletHealthScheduler');

const INTERVAL_MS = parseInt(process.env.WALLET_HEALTH_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.WALLET_HEALTH_CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000;

// Every code the evaluator can emit, so a code with zero schools is published as 0
// and its alert can resolve. Kept in step with WARNING_CODES in walletReadinessService.
const REPORTED_CODES = [
  'ACCOUNT_NOT_FOUND',
  'USDC_TRUSTLINE_MISSING',
  'USDC_NOT_AUTHORIZED',
  'USDC_LIMIT_TOO_LOW',
  'LOW_RESERVE_HEADROOM',
  'THRESHOLD_TOO_LOW',
  'UNKNOWN_SIGNER',
  'MEMO_NOT_REQUIRED',
];

let _timer = null;
let _lastRunAt = null;
let _running = false;

async function runWalletHealthCheck() {
  const schools = await School.find({ isActive: true }).select('schoolId stellarAddress').lean();

  const counts = Object.fromEntries(REPORTED_CODES.map((code) => [code, 0]));
  let checked = 0;
  let unavailable = 0;

  for (const school of schools) {
    const wallet = await assessWallet(school.stellarAddress);
    if (wallet.status === 'unavailable') {
      unavailable += 1;
      continue;
    }
    checked += 1;
    for (const code of new Set(wallet.warnings.map((w) => w.code))) {
      if (code in counts) counts[code] += 1;
    }
  }

  schoolWalletWarningGauge.reset();
  for (const code of REPORTED_CODES) {
    schoolWalletWarningGauge.set({ code }, counts[code]);
  }

  logger.info('Wallet health sweep completed', { schools: schools.length, checked, unavailable, counts });
  return { schools: schools.length, checked, unavailable, counts };
}

async function runIfDue() {
  if (_running) return;
  if (_lastRunAt !== null && Date.now() - _lastRunAt < INTERVAL_MS) return;
  _running = true;
  try {
    await runWalletHealthCheck();
    _lastRunAt = Date.now();
  } catch (err) {
    logger.error('Wallet health scheduler error', { error: err.message });
  } finally {
    _running = false;
  }
}

function startWalletHealthScheduler() {
  if (_timer) return;
  runIfDue();
  _timer = setInterval(runIfDue, CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('Wallet health scheduler started', { intervalMs: INTERVAL_MS, checkIntervalMs: CHECK_INTERVAL_MS });
}

function stopWalletHealthScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('Wallet health scheduler stopped');
  }
}

function getWalletHealthLastRunAt() {
  return _lastRunAt;
}

module.exports = {
  REPORTED_CODES,
  runWalletHealthCheck,
  startWalletHealthScheduler,
  stopWalletHealthScheduler,
  getWalletHealthLastRunAt,
};
