'use strict';

const express = require('express');
const router = express.Router();
const { setLogLevel } = require('../controllers/adminController');
const { listDLQ, retryDLQEntry, replayWebhook } = require('../controllers/webhookAdminController');
const {
  getBacklog,
  listDeadLetterVerifications,
  getDeadLetterVerification,
  retryDeadLetterVerification,
} = require('../controllers/pendingVerificationAdminController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// POST /api/admin/log-level — change log level at runtime
router.post('/log-level', requireAdminAuth, auditContext, setLogLevel);

// Webhook dead-letter queue admin endpoints
router.get('/webhooks/dlq', requireAdminAuth, listDLQ);
router.post('/webhooks/dlq/:id/retry', requireAdminAuth, auditContext, retryDLQEntry);
// Manual replay — accepts any delivery status (Issue #73)
router.post('/webhooks/:id/replay', requireAdminAuth, auditContext, replayWebhook);

// Stellar verification retry backlog / dead-letter admin endpoints
router.get('/pending-verifications/backlog', requireAdminAuth, getBacklog);
router.get('/pending-verifications/dead-letter', requireAdminAuth, listDeadLetterVerifications);
router.get('/pending-verifications/:id', requireAdminAuth, getDeadLetterVerification);
router.post('/pending-verifications/:id/retry', requireAdminAuth, auditContext, retryDeadLetterVerification);

module.exports = router;
