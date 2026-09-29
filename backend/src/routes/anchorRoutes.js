'use strict';

/**
 * Anchor Routes (Issue #1571)
 *
 * Public-facing routes that enable the SEP-24 "Pay with bank / mobile money"
 * flow for parents.  School context is required so the correct anchor
 * configuration is resolved.
 *
 * GET  /api/anchor/anchors              — list enabled anchors for the school
 * POST /api/anchor/initiate             — start a SEP-24 interactive deposit
 * GET  /api/anchor/status/:anchorTxId   — poll anchor deposit status
 */

const express = require('express');
const router = express.Router();
const { listAnchors, initiateDeposit, getDepositStatus } = require('../controllers/anchorController');
const { resolveSchool } = require('../middleware/schoolContext');

// All anchor routes need school context so the right anchor config is used.
router.use(resolveSchool);

// No admin auth required — these are parent-facing endpoints.
router.get('/anchors',                listAnchors);
router.post('/initiate',              initiateDeposit);
router.get('/status/:anchorTxId',     getDepositStatus);

module.exports = router;
