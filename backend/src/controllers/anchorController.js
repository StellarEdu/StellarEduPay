'use strict';

/**
 * Anchor Controller (Issue #1571)
 *
 * Exposes the SEP-24 "Pay with bank / mobile money" flow to the frontend.
 */

const {
  initiateAnchorDeposit,
  fetchAnchorTxStatus,
  resolveAnchorConfig,
  listAnchorsForSchool,
  discoverAnchorEndpoints,
  getCachedSep10Jwt,
} = require('../services/anchorService');
const { validateWebhookUrl } = require('../utils/ssrfGuard');
const { query } = require('../config/database');

/**
 * GET /api/anchor/anchors
 * List all enabled anchors for the current school.
 */
async function listAnchors(req, res, next) {
  try {
    const anchors = await listAnchorsForSchool(req.schoolId);
    // Strip any internal secrets before returning.
    const safe = anchors.map(({ id, homeDomain, assetCode, assetIssuer, label, logoUrl }) => ({
      id,
      homeDomain,
      assetCode,
      assetIssuer: assetIssuer || null,
      label: label || id,
      logoUrl: logoUrl || null,
    }));
    res.json({ data: safe });
  } catch (err) { next(err); }
}

/**
 * POST /api/anchor/initiate
 * Body: { studentId, anchorId }
 * Returns: { interactiveUrl, anchorTxId }
 */
async function initiateDeposit(req, res, next) {
  try {
    const { studentId, anchorId } = req.body;
    if (!studentId || !anchorId) {
      return res.status(400).json({
        error: 'studentId and anchorId are required',
        code: 'VALIDATION_ERROR',
      });
    }

    // Validate the student exists (and belongs to this school) before doing
    // any outbound work against the anchor.
    const studentResult = await query(
      'SELECT id FROM students WHERE id = $1 AND school_id = $2',
      [studentId, req.schoolId],
    );
    if (!studentResult.rows.length) {
      return res.status(400).json({
        error: 'Unknown studentId',
        code: 'VALIDATION_ERROR',
      });
    }

    const result = await initiateAnchorDeposit({
      schoolId: req.schoolId,
      studentId,
      anchorId,
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
}

/**
 * GET /api/anchor/status/:anchorTxId
 * Query: sep24Url (required), anchorId (used to re-authenticate if jwt lost)
 *
 * The frontend polls this endpoint to show deposit progress without
 * needing to hold the SEP-10 JWT in the browser.
 */
async function getDepositStatus(req, res, next) {
  try {
    const { anchorTxId } = req.params;
    const { sep24Url, anchorId } = req.query;

    if (!sep24Url || !anchorId) {
      return res.status(400).json({
        error: 'sep24Url and anchorId query params are required',
        code: 'VALIDATION_ERROR',
      });
    }

    // Validate the caller-supplied SEP-24 URL (HTTPS only, public IPs only).
    const sep24Check = await validateWebhookUrl(sep24Url);
    if (!sep24Check.valid) {
      return res.status(400).json({
        error: `Invalid sep24Url: ${sep24Check.reason || 'not allowed'}`,
        code: 'VALIDATION_ERROR',
      });
    }

    // Reuse the cached SEP-10 JWT (refreshed only when it expires) instead of
    // running a full handshake on every status poll.
    const anchor = await resolveAnchorConfig(req.schoolId, anchorId);
    const { sep10Url } = await discoverAnchorEndpoints(anchor.homeDomain);

    const StellarSdk = require('@stellar/stellar-sdk');
    const keypairSecret = process.env.ANCHOR_PLATFORM_KEYPAIR;
    if (!keypairSecret) {
      return res.status(500).json({
        error: 'ANCHOR_PLATFORM_KEYPAIR not configured',
        code: 'CONFIGURATION_ERROR',
      });
    }
    const platformPublicKey = StellarSdk.Keypair.fromSecret(keypairSecret).publicKey();

    const jwt = await getCachedSep10Jwt(sep10Url, platformPublicKey);

    const anchorTx = await fetchAnchorTxStatus(sep24Url, anchorTxId, jwt);

    res.json({
      anchorTxId,
      status: anchorTx.status,
      stellarTxHash: anchorTx.stellar_transaction_id || null,
      message: anchorTx.message || null,
      amountIn: anchorTx.amount_in || null,
      amountOut: anchorTx.amount_out || null,
      startedAt: anchorTx.started_at || null,
      completedAt: anchorTx.completed_at || null,
    });
  } catch (err) { next(err); }
}

module.exports = { listAnchors, initiateDeposit, getDepositStatus };
