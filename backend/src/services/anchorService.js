'use strict';

/**
 * SEP-24 Anchor Service (Issue #1571)
 *
 * Implements the client-side of the Stellar SEP-24 (hosted deposit/withdrawal)
 * and SEP-10 (Web Authentication) flows so parents can pay school fees using
 * local currency (bank transfer, mobile money, etc.) through a configured anchor
 * without needing an existing Stellar wallet.
 *
 * Flow overview
 * ─────────────
 *  1. POST /api/anchor/initiate — client sends { studentId, schoolId, anchorId }
 *     a. Validate that the anchor is configured and accepted for the school.
 *     b. Perform SEP-10 Web Auth to obtain a JWT for the anchor.
 *     c. Call SEP-24 POST /transactions/deposit/interactive.
 *     d. Return { interactiveUrl, anchorTxId } — front-end opens interactiveUrl in a popup.
 *  2. GET /api/anchor/status/:anchorTxId — poll anchor transaction status.
 *     Returns the SEP-24 transaction status and, when completed, the Stellar txHash.
 *  3. Background: a per-session polling loop checks /transaction?id={anchorTxId}
 *     every 10 s and, when status reaches 'completed', fires the existing
 *     payment verification pipeline.
 *
 * Configuration
 * ─────────────
 * Anchors are configured per school in school.settings.acceptedAnchors:
 *   [{ id, homeDomain, assetCode, assetIssuer, enabled }]
 *
 * Global anchor registry fallback via ANCHOR_CONFIG env var (JSON array).
 *
 * Compliance note
 * ───────────────
 * The anchor performs KYC/AML on the depositing parent. This service only
 * orchestrates the deposit initiation and monitors completion. See
 * docs/stellar-integration.md for compliance responsibilities.
 */

const School = require('../models/schoolModel');
const Student = require('../models/studentModel');
const { processTransaction } = require('./transactionPollingService');
const { server: horizonServer } = require('../config/stellarConfig');
const logger = require('../utils/logger').child('AnchorService');

// ── Global anchor registry (fallback for schools without per-school config) ───
let _globalAnchors = [];
try {
  const raw = process.env.ANCHOR_CONFIG;
  if (raw) _globalAnchors = JSON.parse(raw);
} catch (err) {
  logger.warn('Failed to parse ANCHOR_CONFIG env var', { error: err.message });
}

// In-memory map of active anchor polling jobs: anchorTxId → { timer, schoolId, studentId, attempts }
const _activePolls = new Map();
const ANCHOR_POLL_INTERVAL_MS = parseInt(process.env.ANCHOR_POLL_INTERVAL_MS || '10000', 10);
const ANCHOR_POLL_MAX_ATTEMPTS = parseInt(process.env.ANCHOR_POLL_MAX_ATTEMPTS || '180', 10); // 30 min default

// ── Lazy axios import (avoids hard dependency in test environments) ────────────
function _axios() {
  return require('axios').default;
}

// ── Stellar SDK lazy import ───────────────────────────────────────────────────
function _stellar() {
  return require('@stellar/stellar-sdk');
}

// ── SEP-10 Web Auth helpers ───────────────────────────────────────────────────

/**
 * Discover the SEP-10 and SEP-24 endpoint URLs from an anchor's stellar.toml.
 * @param {string} homeDomain  e.g. 'anchor.example.com'
 * @returns {Promise<{ sep10Url: string, sep24Url: string }>}
 */
async function discoverAnchorEndpoints(homeDomain) {
  const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
  const response = await _axios().get(tomlUrl, { timeout: 10_000 });
  const text = response.data;

  const sep10Match = text.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/);
  const sep24Match = text.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/);

  if (!sep10Match) {
    throw new Error(
      `SEP-10 WEB_AUTH_ENDPOINT not found in ${homeDomain}/.well-known/stellar.toml`
    );
  }
  if (!sep24Match) {
    throw new Error(
      `SEP-24 TRANSFER_SERVER_SEP0024 not found in ${homeDomain}/.well-known/stellar.toml`
    );
  }

  return { sep10Url: sep10Match[1], sep24Url: sep24Match[1] };
}

/**
 * Perform SEP-10 Web Authentication and return an anchor JWT.
 *
 * Steps:
 *  1. GET {sep10Url}?account={account}  — receive challenge transaction
 *  2. Sign with the platform keypair (ANCHOR_PLATFORM_KEYPAIR).
 *  3. POST {sep10Url} with signed transaction — receive JWT.
 *
 * NOTE: ANCHOR_PLATFORM_KEYPAIR should be a dedicated operational account,
 * NOT the school's receiving wallet.
 *
 * @param {string} sep10Url
 * @param {string} account  Stellar public key of the depositing account
 * @returns {Promise<string>} JWT token
 */
async function sep10Authenticate(sep10Url, account) {
  const StellarSdk = _stellar();
  const ax = _axios();

  // 1. Fetch challenge
  const challengeResp = await ax.get(
    `${sep10Url}?account=${encodeURIComponent(account)}`,
    { timeout: 10_000 }
  );
  const challengeTx = challengeResp.data.transaction;
  const networkPassphrase = challengeResp.data.network_passphrase;

  // 2. Sign the challenge
  const keypairSecret = process.env.ANCHOR_PLATFORM_KEYPAIR;
  if (!keypairSecret) {
    throw new Error(
      'ANCHOR_PLATFORM_KEYPAIR is not configured. ' +
      'Set it to the secret key of the platform deposit account to enable SEP-24 flows.'
    );
  }

  const keypair = StellarSdk.Keypair.fromSecret(keypairSecret);
  const tx = new StellarSdk.Transaction(challengeTx, networkPassphrase);
  tx.sign(keypair);
  const signedTx = tx.toEnvelope().toXDR('base64');

  // 3. Submit signed transaction for JWT
  const jwtResp = await ax.post(
    sep10Url,
    { transaction: signedTx },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 }
  );

  const jwt = jwtResp.data.token;
  if (!jwt) throw new Error('SEP-10 authentication did not return a token');
  return jwt;
}

// ── Anchor configuration helpers ─────────────────────────────────────────────

/**
 * Resolve anchor configuration for a school.
 * Per-school settings (school.settings.acceptedAnchors) take precedence over
 * the global ANCHOR_CONFIG registry.
 *
 * @param {string} schoolId
 * @param {string} anchorId
 * @returns {Promise<object>} anchor config object
 */
async function resolveAnchorConfig(schoolId, anchorId) {
  const school = await School.findOne({ schoolId, isActive: true }).lean();
  if (!school) throw Object.assign(new Error('School not found'), { code: 'NOT_FOUND' });

  const schoolAnchors = school.settings?.acceptedAnchors || [];
  const all = [...schoolAnchors, ..._globalAnchors];
  const anchor = all.find(a => a.id === anchorId && a.enabled !== false);

  if (!anchor) {
    throw Object.assign(
      new Error(`Anchor '${anchorId}' is not configured or not enabled for this school`),
      { code: 'ANCHOR_NOT_CONFIGURED', status: 404 }
    );
  }

  return anchor;
}

/**
 * List all enabled anchors for a school (school-specific first, then global).
 * @param {string} schoolId
 * @returns {Promise<object[]>}
 */
async function listAnchorsForSchool(schoolId) {
  const school = await School.findOne({ schoolId, isActive: true }).lean();
  if (!school) throw Object.assign(new Error('School not found'), { code: 'NOT_FOUND' });

  const schoolAnchors = (school.settings?.acceptedAnchors || []).filter(a => a.enabled !== false);
  const globalAnchorIds = new Set(schoolAnchors.map(a => a.id));
  const globalFallbacks = _globalAnchors.filter(
    a => a.enabled !== false && !globalAnchorIds.has(a.id)
  );

  return [...schoolAnchors, ...globalFallbacks];
}

// ── Core: initiate a SEP-24 deposit ──────────────────────────────────────────

/**
 * Initiate a SEP-24 interactive deposit for a student payment.
 *
 * @param {{
 *   schoolId: string,
 *   studentId: string,
 *   anchorId: string,
 * }} options
 * @returns {Promise<{ interactiveUrl: string, anchorTxId: string, sep24Url: string }>}
 */
async function initiateAnchorDeposit({ schoolId, studentId, anchorId }) {
  if (!schoolId || !studentId || !anchorId) {
    throw Object.assign(
      new Error('schoolId, studentId and anchorId are required'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const StellarSdk = _stellar();
  const ax = _axios();

  // 1. Validate student exists.
  const student = await Student.findOne({ schoolId, studentId, deletedAt: null }).lean();
  if (!student) {
    throw Object.assign(new Error(`Student '${studentId}' not found`), { code: 'NOT_FOUND' });
  }

  // 2. Resolve anchor configuration.
  const anchor = await resolveAnchorConfig(schoolId, anchorId);
  const { homeDomain, assetCode, assetIssuer } = anchor;

  // 3. Discover anchor endpoints from stellar.toml.
  const { sep10Url, sep24Url } = await discoverAnchorEndpoints(homeDomain);

  // 4. Platform deposit account.
  const keypairSecret = process.env.ANCHOR_PLATFORM_KEYPAIR;
  if (!keypairSecret) {
    throw new Error('ANCHOR_PLATFORM_KEYPAIR is not configured');
  }
  const platformPublicKey = StellarSdk.Keypair.fromSecret(keypairSecret).publicKey();

  // 5. SEP-10 authentication.
  const jwt = await sep10Authenticate(sep10Url, platformPublicKey);

  // 6. School receiving wallet.
  const school = await School.findOne({ schoolId }).lean();
  const destinationAccount = school.stellarAddress;

  // 7. POST /transactions/deposit/interactive.
  const depositParams = new URLSearchParams({
    asset_code: assetCode,
    account: destinationAccount,
    memo: studentId,
    memo_type: 'text',
  });
  if (assetIssuer) depositParams.set('asset_issuer', assetIssuer);

  const depositResp = await ax.post(
    `${sep24Url}/transactions/deposit/interactive`,
    depositParams.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${jwt}`,
      },
      timeout: 15_000,
    }
  );

  const interactiveUrl = depositResp.data.url;
  const anchorTxId = depositResp.data.id;
  if (!interactiveUrl || !anchorTxId) {
    throw new Error(
      'SEP-24 deposit initiation did not return interactive URL or transaction ID'
    );
  }

  logger.info('SEP-24 deposit initiated', { schoolId, studentId, anchorId, anchorTxId });

  // 8. Start background polling to detect deposit completion.
  _startAnchorPolling({ anchorTxId, sep24Url, jwt, schoolId, studentId });

  return { interactiveUrl, anchorTxId, sep24Url };
}

// ── Anchor transaction status polling ────────────────────────────────────────

/**
 * Fetch the current status of an anchor transaction via SEP-24.
 * @param {string} sep24Url
 * @param {string} anchorTxId
 * @param {string} jwt
 * @returns {Promise<object>} SEP-24 transaction object
 */
async function fetchAnchorTxStatus(sep24Url, anchorTxId, jwt) {
  const resp = await _axios().get(
    `${sep24Url}/transaction?id=${encodeURIComponent(anchorTxId)}`,
    { headers: { Authorization: `Bearer ${jwt}` }, timeout: 10_000 }
  );
  return resp.data.transaction;
}

/**
 * Start a polling loop that watches an anchor transaction and, when it reaches
 * 'completed', fetches the Stellar transaction from Horizon and routes it
 * through the existing processTransaction pipeline.
 */
function _startAnchorPolling({ anchorTxId, sep24Url, jwt, schoolId, studentId }) {
  if (_activePolls.has(anchorTxId)) return; // already polling

  let attempts = 0;

  async function poll() {
    if (!_activePolls.has(anchorTxId)) return; // cancelled

    attempts++;
    if (attempts > ANCHOR_POLL_MAX_ATTEMPTS) {
      logger.warn('Anchor polling max attempts reached — giving up', { anchorTxId, schoolId });
      _activePolls.delete(anchorTxId);
      return;
    }

    let anchorTx;
    try {
      anchorTx = await fetchAnchorTxStatus(sep24Url, anchorTxId, jwt);
    } catch (err) {
      logger.warn('Anchor status poll failed', { anchorTxId, error: err.message });
      _rescheduleAnchorPoll(anchorTxId, poll);
      return;
    }

    const status = anchorTx?.status;
    logger.debug('Anchor tx status', { anchorTxId, status, schoolId });

    if (status === 'completed') {
      _activePolls.delete(anchorTxId);
      const stellarTxHash = anchorTx.stellar_transaction_id;
      if (stellarTxHash) {
        await _processCompletedAnchorDeposit({ stellarTxHash, schoolId, studentId });
      } else {
        logger.warn('Anchor deposit completed but no stellar_transaction_id', { anchorTxId });
      }
      return;
    }

    if (status === 'error' || status === 'refunded') {
      logger.warn('Anchor deposit ended in terminal non-success state', { anchorTxId, status });
      _activePolls.delete(anchorTxId);
      return;
    }

    // Still pending/processing — reschedule.
    _rescheduleAnchorPoll(anchorTxId, poll);
  }

  const timer = setTimeout(poll, ANCHOR_POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  _activePolls.set(anchorTxId, { timer, schoolId, studentId, attempts: 0 });
}

function _rescheduleAnchorPoll(anchorTxId, pollFn) {
  const entry = _activePolls.get(anchorTxId);
  if (!entry) return;
  const timer = setTimeout(pollFn, ANCHOR_POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  entry.timer = timer;
}

/**
 * Fetch the Stellar transaction from Horizon and route it through the existing
 * processTransaction pipeline so the payment is recorded, student balance
 * updated, and SSE/webhook events fire.
 */
async function _processCompletedAnchorDeposit({ stellarTxHash, schoolId, studentId }) {
  try {
    const school = await School.findOne({ schoolId, isActive: true }).lean();
    if (!school) {
      logger.warn('School not found when processing anchor deposit', { schoolId, stellarTxHash });
      return;
    }

    const tx = await horizonServer.transactions().transaction(stellarTxHash).call();
    if (!tx) {
      logger.warn('Horizon returned no transaction for anchor deposit', { stellarTxHash });
      return;
    }

    const fencingToken = Date.now();
    const result = await processTransaction(tx, school, fencingToken);

    logger.info('Anchor deposit processed', {
      schoolId,
      studentId,
      stellarTxHash,
      processed: result?.processed,
      reason: result?.reason,
    });
  } catch (err) {
    logger.error('Failed to process completed anchor deposit', {
      schoolId,
      studentId,
      stellarTxHash,
      error: err.message,
    });
  }
}

/**
 * Stop all active anchor polling loops (called on graceful shutdown).
 */
function stopAllAnchorPolls() {
  for (const [anchorTxId, { timer }] of _activePolls) {
    clearTimeout(timer);
    logger.debug('Stopped anchor poll on shutdown', { anchorTxId });
  }
  _activePolls.clear();
}

module.exports = {
  initiateAnchorDeposit,
  fetchAnchorTxStatus,
  resolveAnchorConfig,
  listAnchorsForSchool,
  discoverAnchorEndpoints,
  sep10Authenticate,
  stopAllAnchorPolls,
  // exposed for testing
  _activePolls,
};
