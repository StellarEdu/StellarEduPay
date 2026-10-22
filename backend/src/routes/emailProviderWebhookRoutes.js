'use strict';

/**
 * DEPRECATED alias (Issue #1641) — kept for one release.
 *
 * POST /api/email-provider-webhook/callback is now handled by the consolidated
 * provider webhook (POST /api/email/webhooks/generic), so a call here both
 * updates delivery status and maintains the suppression list. Point providers
 * at /api/email/webhooks/:provider instead; see docs/email-delivery.md.
 */

const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/emailWebhookController');
const { genericEmailWebhookAuth } = require('../middleware/genericEmailWebhookAuth');
const logger = require('../utils/logger').child('EmailProviderWebhookAlias');

router.post('/callback', (req, res, next) => {
  logger.warn('Deprecated email webhook path used; switch to /api/email/webhooks/generic', { ip: req.ip });
  res.set('Deprecation', 'true');
  res.set('Link', '</api/email/webhooks/generic>; rel="successor-version"');
  next();
}, genericEmailWebhookAuth(), (req, res, next) => {
  req.params.provider = 'generic';
  handleWebhook(req, res).catch(next);
});

module.exports = router;
