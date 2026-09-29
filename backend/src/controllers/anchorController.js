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
} = require('../services/anchorService');

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

    // Re-authenticate to get a fresh JWT for status checks.
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

    const { sep10Authenticate } = require('../services/anchorService');
    const jwt = await sep10Authenticate(sep10Url, platformPublicKey);

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
