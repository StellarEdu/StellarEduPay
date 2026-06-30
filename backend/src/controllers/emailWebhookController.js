'use strict';

/**
 * Email provider bounce/complaint webhooks and suppression-list admin (Issue #80).
 *
 *   POST /api/email/webhooks/:provider  — provider callbacks (SES/SNS, SendGrid).
 *                                         Shared-secret protected (EMAIL_WEBHOOK_SECRET).
 *   GET  /api/email/suppressions        — list suppressed addresses (admin).
 *   POST /api/email/suppressions        — manually suppress an address (admin).
 *   DELETE /api/email/suppressions/:email — clear a suppression (admin).
 */

const suppressionList = require('../services/email/suppressionList');
const logger = require('../utils/logger').child('EmailWebhook');

function checkSecret(req) {
  const expected = process.env.EMAIL_WEBHOOK_SECRET;
  if (!expected) return true; // not configured — accept (dev). Set it in prod.
  const provided = req.headers['x-webhook-token'] || req.query.token;
  return provided === expected;
}

/**
 * Normalise provider-specific payloads into a list of
 * { email, kind: 'bounce'|'complaint', bounceType?, detail }.
 */
function parseEvents(provider, body) {
  const events = [];

  if (provider === 'ses') {
    // SES delivers via SNS; the Message field is a JSON string.
    let msg = body;
    if (body && typeof body.Message === 'string') {
      try { msg = JSON.parse(body.Message); } catch { msg = body; }
    }
    if (msg?.notificationType === 'Bounce' && msg.bounce) {
      const hard = msg.bounce.bounceType === 'Permanent';
      for (const r of msg.bounce.bouncedRecipients || []) {
        events.push({ email: r.emailAddress, kind: 'bounce', bounceType: hard ? 'hard' : 'soft', detail: r.diagnosticCode });
      }
    } else if (msg?.notificationType === 'Complaint' && msg.complaint) {
      for (const r of msg.complaint.complainedRecipients || []) {
        events.push({ email: r.emailAddress, kind: 'complaint', detail: msg.complaint.complaintFeedbackType });
      }
    }
  } else if (provider === 'sendgrid') {
    // SendGrid posts an array of event objects.
    const arr = Array.isArray(body) ? body : [body];
    for (const ev of arr) {
      if (!ev || !ev.email) continue;
      if (ev.event === 'bounce' || ev.event === 'dropped') {
        const hard = ev.type === 'bounce' || ev.event === 'bounce';
        events.push({ email: ev.email, kind: 'bounce', bounceType: hard ? 'hard' : 'soft', detail: ev.reason });
      } else if (ev.event === 'spamreport') {
        events.push({ email: ev.email, kind: 'complaint', detail: 'spamreport' });
      }
    }
  }

  return events;
}

async function handleWebhook(req, res) {
  const { provider } = req.params;

  if (!['ses', 'sendgrid'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider', code: 'UNSUPPORTED_PROVIDER' });
  }
  if (!checkSecret(req)) {
    return res.status(401).json({ error: 'Invalid webhook token', code: 'UNAUTHORIZED' });
  }

  try {
    const events = parseEvents(provider, req.body);
    for (const ev of events) {
      if (ev.kind === 'bounce') {
        await suppressionList.recordBounce(ev.email, { bounceType: ev.bounceType, source: provider, detail: ev.detail });
      } else if (ev.kind === 'complaint') {
        await suppressionList.recordComplaint(ev.email, { source: provider, detail: ev.detail });
      }
    }
    logger.info('Processed email webhook', { provider, events: events.length });
    return res.status(200).json({ processed: events.length });
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
  return res.status(201).json(record);
}

async function removeSuppression(req, res) {
  const removed = await suppressionList.remove(req.params.email);
  return res.status(200).json({ removed });
}

module.exports = { handleWebhook, listSuppressions, addSuppression, removeSuppression, parseEvents };
