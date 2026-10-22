'use strict';

/**
 * Email provider webhooks and suppression-list admin (Issue #80).
 *
 *   POST /api/email/webhooks/:provider  — the single endpoint for provider
 *                                         callbacks (SES/SNS, SendGrid, generic).
 *                                         Authenticated per provider — see
 *                                         authenticateWebhook() (Issue #1537) —
 *                                         with replay protection, and handles
 *                                         events end to end: suppression list
 *                                         AND delivery status (Issue #1641).
 *   GET  /api/email/suppressions        — list suppressed addresses (admin).
 *   POST /api/email/suppressions        — manually suppress an address (admin).
 *   DELETE /api/email/suppressions/:email — clear a suppression (admin).
 */

const axios = require('axios');
const crypto = require('crypto');
const suppressionList = require('../services/email/suppressionList');
const { parseEvents, processEvents } = require('../services/email/providerEvents');
const InboundWebhookNonce = require('../models/inboundWebhookNonceModel');
const {
  safeEqualSecret,
  isAllowedSnsUrl,
  verifySnsMessage,
  verifySendGridSignature,
} = require('../services/email/webhookVerification');
const logger = require('../utils/logger').child('EmailWebhook');
const { logAudit } = require('../services/auditService');

const SUPPORTED_PROVIDERS = ['ses', 'sendgrid', 'generic'];
const REPLAY_TOLERANCE_S = parseInt(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, 10) || 300;

// ── Authentication — Issue #1537 ─────────────────────────────────────────────
//
// This route writes to the suppression list, which permanently stops emails
// to parents, so it must never fail open in production:
//
//   ses       SNS message signature is verified (SigningCertURL must be on
//             sns.<region>.amazonaws.com) and TopicArn must be listed in
//             EMAIL_SNS_TOPIC_ARNS. Unsigned messages are rejected in production.
//   sendgrid  When EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY is set the Signed Event
//             Webhook signature is required; otherwise the shared secret in
//             the X-Webhook-Token header is required.
//
// The shared secret (EMAIL_WEBHOOK_SECRET) is accepted ONLY via the
// X-Webhook-Token header and compared in constant time — a ?token= query
// parameter is rejected outright so secrets never end up in access logs.
//
// Outside production, when no authentication at all is configured, calls are
// accepted with a warning so local development keeps working.

function _isProduction() {
  return process.env.NODE_ENV === 'production';
}

function _authConfig() {
  return {
    secret: process.env.EMAIL_WEBHOOK_SECRET || null,
    snsTopicArns: (process.env.EMAIL_SNS_TOPIC_ARNS || '')
      .split(',').map((t) => t.trim()).filter(Boolean),
    sendgridPublicKey: process.env.EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY || null,
  };
}

/**
 * True when at least one authentication mechanism is configured.
 */
function isWebhookAuthConfigured() {
  const cfg = _authConfig();
  return Boolean(cfg.secret || cfg.snsTopicArns.length > 0 || cfg.sendgridPublicKey);
}

/**
 * Called once at startup (app.js). In production with no authentication
 * configured the route stays mounted but rejects every call with 503, so the
 * suppression list can never be written by unauthenticated callers.
 */
function checkEmailWebhookConfigOnStartup() {
  if (_isProduction() && !isWebhookAuthConfigured()) {
    logger.error(
      'Email bounce/complaint webhook is DISABLED: none of EMAIL_SNS_TOPIC_ARNS, ' +
      'EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY or EMAIL_WEBHOOK_SECRET is set. ' +
      'POST /api/email/webhooks/:provider will return 503 until one is configured.'
    );
    return false;
  }
  return true;
}

function _reject(req, provider, status, reason) {
  // Log (never store) rejected attempts, and count them for alerting.
  logger.warn('Rejected email webhook call', { provider, reason, ip: req.ip });
  try {
    const { recordEmailWebhookRejection } = require('../metrics/emailWebhookMetrics');
    recordEmailWebhookRejection(provider, reason);
  } catch (_) {}
  return { ok: false, status, reason };
}

/**
 * SNS delivers with Content-Type text/plain, so the body may arrive as a raw
 * string (parsed by express.text in emailRoutes.js) rather than an object.
 */
function _parseBody(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return null; }
  }
  return body;
}

/**
 * Authenticate a provider webhook call.
 *
 * @returns {Promise<{ok: true, sns?: object} | {ok: false, status: number, reason: string}>}
 */
async function authenticateWebhook(req, provider, body) {
  const cfg = _authConfig();
  const production = _isProduction();

  if (req.query && req.query.token !== undefined) {
    return _reject(req, provider, 400, 'SECRET_IN_QUERY_STRING');
  }

  // generic: HMAC signature, timestamp and delivery-ID dedup are enforced by
  // the route's validateInboundWebhook middleware (see emailRoutes.js), which
  // marks the request as verified.
  if (provider === 'generic') {
    return req.inboundWebhookVerified ? { ok: true } : _reject(req, provider, 401, 'UNAUTHENTICATED');
  }

  if (production && !isWebhookAuthConfigured()) {
    return _reject(req, provider, 503, 'EMAIL_WEBHOOK_NOT_CONFIGURED');
  }

  const headerToken = req.headers['x-webhook-token'];
  // A shared-secret header, when sent, must always be correct.
  if (headerToken !== undefined && cfg.secret && !safeEqualSecret(headerToken, cfg.secret)) {
    return _reject(req, provider, 401, 'INVALID_SHARED_SECRET');
  }
  const sharedSecretOk = Boolean(cfg.secret && safeEqualSecret(headerToken, cfg.secret));

  if (provider === 'ses') {
    const isSnsEnvelope = body && typeof body === 'object' && typeof body.Type === 'string';
    if (isSnsEnvelope && (body.Signature || production || cfg.snsTopicArns.length > 0)) {
      const check = await verifySnsMessage(body);
      if (!check.valid) return _reject(req, provider, 401, check.reason);
      if (cfg.snsTopicArns.length === 0) {
        if (production) return _reject(req, provider, 403, 'SNS_TOPIC_ALLOWLIST_NOT_CONFIGURED');
      } else if (!cfg.snsTopicArns.includes(body.TopicArn)) {
        return _reject(req, provider, 403, 'SNS_TOPIC_NOT_ALLOWED');
      }
      return { ok: true, sns: body };
    }
    // Unsigned SES payload (e.g. local testing without SNS).
    if (production) return _reject(req, provider, 401, 'UNSIGNED_SNS_MESSAGE');
    if (sharedSecretOk || !isWebhookAuthConfigured()) return { ok: true };
    return _reject(req, provider, 401, 'UNAUTHENTICATED');
  }

  if (provider === 'sendgrid') {
    if (cfg.sendgridPublicKey) {
      const check = verifySendGridSignature({
        publicKey: cfg.sendgridPublicKey,
        signature: req.headers['x-twilio-email-event-webhook-signature'],
        timestamp: req.headers['x-twilio-email-event-webhook-timestamp'],
        rawBody: req.rawBody,
      });
      if (!check.valid) return _reject(req, provider, 401, check.reason);
      return { ok: true };
    }
    if (sharedSecretOk) return { ok: true };
    if (!production && !isWebhookAuthConfigured()) {
      logger.warn('Accepting unauthenticated email webhook (no auth configured; non-production only)', { provider });
      return { ok: true };
    }
    return _reject(req, provider, 401, cfg.secret ? 'INVALID_SHARED_SECRET' : 'UNAUTHENTICATED');
  }

  return _reject(req, provider, 400, 'UNSUPPORTED_PROVIDER');
}

/**
 * Confirm an SNS subscription by fetching its SubscribeURL — only ever called
 * after the message signature and TopicArn have been verified.
 */
async function _confirmSnsSubscription(req, msg) {
  if (!isAllowedSnsUrl(msg.SubscribeURL)) {
    return _reject(req, 'ses', 400, 'INVALID_SNS_SUBSCRIBE_URL');
  }
  await axios.get(msg.SubscribeURL, { timeout: 5000, maxRedirects: 0 });
  logger.info('Confirmed SNS subscription', { topicArn: msg.TopicArn });
  return { ok: true };
}

/**
 * Replay protection for provider-native callbacks (#1641). Generic callbacks
 * are deduplicated by validateInboundWebhook already.
 *
 *   ses       SNS MessageId is unique per message; a redelivered or replayed
 *             message is acknowledged without being processed again.
 *   sendgrid  The signed timestamp must be within the tolerance window, and
 *             the (timestamp, signature) pair may only be used once.
 *
 * @returns {Promise<{ok: true, duplicate?: boolean} | {ok: false, status: number, reason: string}>}
 */
async function checkReplay(req, provider, body) {
  let nonce = null;
  if (provider === 'ses' && body && typeof body.MessageId === 'string') {
    nonce = `email:ses:${body.MessageId}`;
  } else if (provider === 'sendgrid') {
    const signature = req.headers['x-twilio-email-event-webhook-signature'];
    const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'];
    if (signature && timestamp) {
      const ts = parseInt(timestamp, 10);
      if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > REPLAY_TOLERANCE_S) {
        return _reject(req, provider, 400, 'TIMESTAMP_SKEW');
      }
      nonce = `email:sendgrid:${crypto.createHash('sha256').update(`${timestamp}.${signature}`).digest('hex')}`;
    }
  }
  if (!nonce) return { ok: true };

  try {
    await InboundWebhookNonce.create({ deliveryId: nonce });
  } catch (err) {
    if (err.code === 11000) {
      logger.warn('Duplicate email webhook delivery ignored', { provider });
      return { ok: true, duplicate: true };
    }
    // Nonce store unavailable — log and process rather than drop the event.
    logger.error('Email webhook nonce store error', { provider, error: err.message });
  }
  return { ok: true };
}

async function handleWebhook(req, res) {
  const { provider } = req.params;

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider', code: 'UNSUPPORTED_PROVIDER' });
  }

  const body = _parseBody(req.body);
  if (body === null || body === undefined) {
    return res.status(400).json({ error: 'Invalid JSON payload', code: 'INVALID_PAYLOAD' });
  }

  let auth;
  try {
    auth = await authenticateWebhook(req, provider, body);
  } catch (err) {
    logger.error('Email webhook authentication error', { provider, error: err.message });
    auth = _reject(req, provider, 401, 'AUTHENTICATION_ERROR');
  }
  if (!auth.ok) {
    const code = auth.status === 503 ? 'EMAIL_WEBHOOK_NOT_CONFIGURED' : 'UNAUTHORIZED';
    return res.status(auth.status).json({ error: 'Webhook authentication failed', code, reason: auth.reason });
  }

  // SNS control messages (only reachable after signature + topic checks).
  if (auth.sns && auth.sns.Type === 'SubscriptionConfirmation') {
    try {
      const confirmed = await _confirmSnsSubscription(req, auth.sns);
      if (!confirmed.ok) {
        return res.status(confirmed.status).json({ error: 'Invalid SubscribeURL', code: 'UNAUTHORIZED', reason: confirmed.reason });
      }
      return res.status(200).json({ confirmed: true });
    } catch (err) {
      logger.error('Failed to confirm SNS subscription', { topicArn: auth.sns.TopicArn, error: err.message });
      return res.status(502).json({ error: 'Subscription confirmation failed', code: 'SNS_CONFIRMATION_FAILED' });
    }
  }
  if (auth.sns && auth.sns.Type === 'UnsubscribeConfirmation') {
    logger.warn('SNS subscription removed', { topicArn: auth.sns.TopicArn });
    return res.status(200).json({ processed: 0 });
  }

  const replay = await checkReplay(req, provider, body);
  if (!replay.ok) {
    return res.status(replay.status).json({ error: 'Webhook replay check failed', code: 'UNAUTHORIZED', reason: replay.reason });
  }
  if (replay.duplicate) {
    return res.status(200).json({ processed: 0, duplicate: true });
  }

  try {
    // #1641: one pass updates both the suppression list and delivery status.
    const events = parseEvents(provider, body);
    const result = await processEvents(provider, events);
    return res.status(200).json(result);
  } catch (err) {
    logger.error('Failed to process email webhook', { provider, error: err.message });
    return res.status(500).json({ error: 'Webhook processing failed', code: 'WEBHOOK_ERROR' });
  }
}

async function listSuppressions(req, res) {
  const { limit, skip } = req.query;
  const result = await suppressionList.list({ limit, skip });
  return res.status(200).json(result);
}

async function addSuppression(req, res) {
  const { email, reason = 'manual', bounceType, detail } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'email is required', code: 'VALIDATION_ERROR' });
  }
  const record = await suppressionList.suppress(email, { reason, bounceType, source: 'admin', detail });
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'EMAIL_SUPPRESSION_ADDED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: email,
    targetType: 'emailAddress',
    details: { reason, bounceType, detail },
  });
  return res.status(201).json(record);
}

async function removeSuppression(req, res) {
  const removed = await suppressionList.remove(req.params.email);
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'EMAIL_SUPPRESSION_REMOVED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: req.params.email,
    targetType: 'emailAddress',
    details: { removed },
  });
  return res.status(200).json({ removed });
}

module.exports = {
  handleWebhook,
  listSuppressions,
  addSuppression,
  removeSuppression,
  parseEvents,
  authenticateWebhook,
  checkReplay,
  isWebhookAuthConfigured,
  checkEmailWebhookConfigOnStartup,
};
