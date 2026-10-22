'use strict';

/**
 * Authentication for generic (pre-normalised) email provider callbacks —
 * Issue #1641.
 *
 * Wraps validateInboundWebhook (HMAC over the raw body, timestamp skew and
 * delivery-ID dedup) with EMAIL_PROVIDER_WEBHOOK_SECRET. Unlike the bare
 * middleware it never fails open: with no secret configured the route answers
 * 503 in production. Outside production, unsigned calls are accepted with a
 * warning so local development keeps working.
 */

const { validateInboundWebhook } = require('./validateInboundWebhook');
const logger = require('../utils/logger').child('GenericEmailWebhookAuth');

function _secret() {
  return process.env.EMAIL_PROVIDER_WEBHOOK_SECRET || null;
}

function genericEmailWebhookAuth() {
  const verify = validateInboundWebhook(() => _secret());
  return function (req, res, next) {
    if (!_secret()) {
      if (process.env.NODE_ENV === 'production') {
        logger.error('Generic email webhook rejected: EMAIL_PROVIDER_WEBHOOK_SECRET is not set');
        return res.status(503).json({ error: 'Email provider webhook is not configured', code: 'EMAIL_WEBHOOK_NOT_CONFIGURED' });
      }
      logger.warn('Accepting unsigned generic email webhook (no secret configured; non-production only)');
      req.inboundWebhookVerified = true;
      return next();
    }
    return verify(req, res, (err) => {
      if (err) return next(err);
      req.inboundWebhookVerified = true;
      return next();
    });
  };
}

module.exports = { genericEmailWebhookAuth };
