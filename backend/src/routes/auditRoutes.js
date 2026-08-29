'use strict';

const express = require('express');
const router = express.Router();
const { getAuditLogsEndpoint, getRecentAuditLogsEndpoint, verifyChainEndpoint, exportAuditLogsEndpoint } = require('../controllers/auditController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');

router.use(resolveSchool);
router.use(requireAdminAuth);

router.get('/',              getAuditLogsEndpoint);
router.get('/recent',        getRecentAuditLogsEndpoint);
// #1370 — CSV / JSON export for compliance and handover use-cases
router.get('/export',        exportAuditLogsEndpoint);
// #885 — verify hash-chain integrity
router.get('/verify-chain',  verifyChainEndpoint);

module.exports = router;
