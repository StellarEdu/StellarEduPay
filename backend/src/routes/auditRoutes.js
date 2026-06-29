'use strict';

const express = require('express');
const router = express.Router();
const { getAuditLogsEndpoint, getRecentAuditLogsEndpoint, verifyChainEndpoint } = require('../controllers/auditController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');

router.use(resolveSchool);
router.use(requireAdminAuth);

router.get('/',              getAuditLogsEndpoint);
router.get('/recent',        getRecentAuditLogsEndpoint);
// #885 — verify hash-chain integrity
router.get('/verify-chain',  verifyChainEndpoint);

module.exports = router;
