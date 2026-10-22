'use strict';

const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const {
  handleWebhook,
  listSuppressions,
  addSuppression,
  removeSuppression,
} = require('../controllers/emailWebhookController');
const { genericEmailWebhookAuth } = require('../middleware/genericEmailWebhookAuth');

// Public provider webhooks (bounce/complaint). Authenticated inside the
// controller (SNS / SendGrid signature verification or the X-Webhook-Token
// shared secret — Issue #1537), not by admin auth. Amazon SNS posts with
// Content-Type text/plain, so accept a text body here and parse it as JSON in
// the controller.
//
// Issue #1641: this is the single endpoint for provider events. Each call both
// maintains the suppression list and updates email delivery status.
//   /webhooks/ses       Amazon SES via SNS (SNS signature + topic allow-list)
//   /webhooks/sendgrid  SendGrid Event Webhook (ECDSA signature)
//   /webhooks/generic   pre-normalised events, HMAC-signed with
//                       EMAIL_PROVIDER_WEBHOOK_SECRET (replaces
//                       /api/email-provider-webhook/callback)
router.post('/webhooks/generic', genericEmailWebhookAuth(), (req, res, next) => {
  req.params.provider = 'generic';
  handleWebhook(req, res).catch(next);
});
router.post('/webhooks/:provider', express.text({ type: 'text/plain', limit: '256kb' }), handleWebhook);

// Suppression-list administration (admin only).
// #1554 — addSuppression and removeSuppression mutate delivery state and must
// be attributed to an actor in the audit trail.
router.use('/suppressions', requireAdminAuth);
router.get('/suppressions', listSuppressions);
router.post('/suppressions', auditContext, addSuppression);
router.delete('/suppressions/:email', auditContext, removeSuppression);

module.exports = router;
