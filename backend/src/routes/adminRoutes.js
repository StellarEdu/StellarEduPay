'use strict';

const express = require('express');
const router = express.Router();
const { setLogLevel } = require('../controllers/adminController');
const { listDLQ, retryDLQEntry } = require('../controllers/webhookAdminController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// POST /api/admin/log-level — change log level at runtime
router.post('/log-level', requireAdminAuth, auditContext, setLogLevel);

// Webhook dead-letter queue admin endpoints
router.get('/webhooks/dlq', requireAdminAuth, listDLQ);
router.post('/webhooks/dlq/:id/retry', requireAdminAuth, auditContext, retryDLQEntry);

module.exports = router;
