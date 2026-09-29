'use strict';

/**
 * Inbound Webhook Replay Protection Middleware
 *
 * Enforces the StellarEduPay receiver-side verification contract:
 *   1. Signature — HMAC-SHA256 over the raw body, verified with the shared secret.
 *   2. Timestamp skew — reject deliveries where X-StellarEduPay-Timestamp is
 *      older than WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS (default: 5 minutes).
 *   3. Delivery-ID dedup — store seen delivery IDs in MongoDB with a TTL so
 *      a replayed delivery is rejected with 409.
 *
 * Usage:
 *   router.post('/callback', validateInboundWebhook(getSecret), handler);
 *
 * @param {Function|string} secretOrFn  - The HMAC secret, or a function
 *   (req) => string|Promise<string> that resolves the secret per-request.
 */

const crypto = require('crypto');
const InboundWebhookNonce = require('../models/inboundWebhookNonceModel');
const logger = require('../utils/logger').child('WebhookReplayProtection');

const TOLERANCE_SECONDS = parseInt(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, 10) || 300; // 5 min

/**
 * Verify HMAC-SHA256 signature.
 * Header format: `sha256=<hex>`
 *
 * The raw body is expected to be a Buffer (captured by the route-level
 * express.raw()/express.json({ verify }) parser). A string is still accepted
 * for backwards compatibility and is encoded as UTF-8 before hashing.
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const hex = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Factory: returns an Express middleware that enforces replay protection.
 *
 * @param {string|Function} secretOrFn
 */
function validateInboundWebhook(secretOrFn) {
  return async function (req, res, next) {
    try {
      const signatureHeader = req.headers['x-stellaredupay-signature'];
      const timestampHeader = req.headers['x-stellaredupay-timestamp'];
      const deliveryId      = req.headers['x-stellaredupay-delivery-id'];

      // ── 1. Timestamp skew check ───────────────────────────────────────────
      if (!timestampHeader) {
        return res.status(400).json({ error: 'Missing X-StellarEduPay-Timestamp', code: 'MISSING_TIMESTAMP' });
      }
      const ts = parseInt(timestampHeader, 10);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SECONDS) {
        logger.warn('Webhook rejected: timestamp skew', { ts, now, diff: now - ts });
        return res.status(400).json({ error: 'Timestamp outside acceptable window', code: 'TIMESTAMP_SKEW' });
      }

      // ── 2. Signature verification ─────────────────────────────────────────
      const secret = typeof secretOrFn === 'function' ? await secretOrFn(req) : secretOrFn;
      if (secret) {
        // Prefer the raw Buffer captured by the route-level parser. Fall back
        // to a re-serialised body only when no raw body was captured.
        const rawBody = req.rawBody || JSON.stringify(req.body);
        if (!verifySignature(rawBody, signatureHeader, secret)) {
          logger.warn('Webhook rejected: invalid signature', { deliveryId });
          return res.status(401).json({ error: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' });
        }
      }

      // ── 3. Delivery-ID dedup ──────────────────────────────────────────────
      // #1182 — Use InboundWebhookNonce (a minimal nonce store) rather than the
      // outbound WebhookDelivery model.  WebhookDelivery has several required
      // fields (endpointId, schoolId, event, success) that are not available in
      // this inbound middleware, so calling WebhookDelivery.create({ deliveryId })
      // threw a Mongoose validation error before MongoDB could produce a 11000
      // duplicate-key error — meaning duplicate deliveries were never caught.
      if (deliveryId) {
        try {
          await InboundWebhookNonce.create({ deliveryId });
        } catch (err) {
          if (err.code === 11000) {
            // Duplicate key — this delivery was already processed
            logger.warn('Webhook rejected: duplicate delivery-ID', { deliveryId });
            return res.status(409).json({ error: 'Duplicate delivery — already processed', code: 'DUPLICATE_DELIVERY' });
          }
          // Non-dedup error — log and continue (don't block processing)
          logger.error('Webhook delivery-ID store error', { error: err.message, deliveryId });
        }
      }

      next();
    } catch (err) {
      logger.error('validateInboundWebhook error', { error: err.message });
      next(err);
    }
  };
}

module.exports = { validateInboundWebhook, verifySignature, TOLERANCE_SECONDS };
