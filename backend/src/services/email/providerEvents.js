'use strict';

/**
 * Provider event processing — Issue #1641.
 *
 * Email provider callbacks used to arrive at two endpoints: one maintained the
 * suppression list, the other updated EmailDelivery status. A provider wired
 * to only one of them either kept emailing bounced addresses or never updated
 * delivery statuses. Every provider event now goes through processEvents(),
 * which does both:
 *
 *   1. Bounces and complaints are recorded on the suppression list.
 *   2. Events carrying a provider message id update EmailDelivery (and, for
 *      bounces/complaints, the matching student's suppression flag).
 *
 * Events are normalised first by parseEvents() into
 *   { kind, email, bounceType?, detail, providerMessageId, timestamp, raw }
 * where kind is 'delivered' | 'opened' | 'bounce' | 'complaint' | 'failed'.
 */

const suppressionList = require('./suppressionList');
const logger = require('../../utils/logger').child('EmailProviderEvents');

// kind → EmailDelivery eventType understood by handleEmailProviderEvent
const DELIVERY_EVENT_TYPES = {
  delivered: 'delivered',
  opened: 'opened',
  bounce: 'bounced',
  complaint: 'complaint',
  failed: 'failed',
};

// Generic (pre-normalised) eventType → kind
const GENERIC_KINDS = {
  delivered: 'delivered',
  opened: 'opened',
  bounced: 'bounce',
  bounce: 'bounce',
  complaint: 'complaint',
  failed: 'failed',
};

function _toDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  // SendGrid sends unix seconds; everything else ISO strings or ms.
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function _parseSes(body) {
  // SES delivers via SNS; the Message field is a JSON string.
  let msg = body;
  if (body && typeof body.Message === 'string') {
    try { msg = JSON.parse(body.Message); } catch { msg = body; }
  }
  const events = [];
  const messageId = msg?.mail?.messageId || null;
  const type = msg?.notificationType || msg?.eventType;

  if (type === 'Bounce' && msg.bounce) {
    const hard = msg.bounce.bounceType === 'Permanent';
    for (const r of msg.bounce.bouncedRecipients || []) {
      events.push({
        kind: 'bounce', email: r.emailAddress, bounceType: hard ? 'hard' : 'soft',
        detail: r.diagnosticCode, providerMessageId: messageId, timestamp: _toDate(msg.bounce.timestamp),
      });
    }
  } else if (type === 'Complaint' && msg.complaint) {
    for (const r of msg.complaint.complainedRecipients || []) {
      events.push({
        kind: 'complaint', email: r.emailAddress, detail: msg.complaint.complaintFeedbackType,
        providerMessageId: messageId, timestamp: _toDate(msg.complaint.timestamp),
      });
    }
  } else if (type === 'Delivery' && msg.delivery) {
    for (const email of msg.delivery.recipients || []) {
      events.push({
        kind: 'delivered', email, detail: msg.delivery.smtpResponse,
        providerMessageId: messageId, timestamp: _toDate(msg.delivery.timestamp),
      });
    }
  } else if (type === 'Open' && msg.open) {
    events.push({
      kind: 'opened', email: (msg.mail?.destination || [])[0] || null, detail: null,
      providerMessageId: messageId, timestamp: _toDate(msg.open.timestamp),
    });
  }
  return events;
}

function _parseSendGrid(body) {
  const events = [];
  const arr = Array.isArray(body) ? body : [body];
  for (const ev of arr) {
    if (!ev || !ev.email) continue;
    // sg_message_id is "<x-message-id>.<filter suffix>"; the send API returns
    // the part before the first dot.
    const providerMessageId = typeof ev.sg_message_id === 'string' ? ev.sg_message_id.split('.')[0] : null;
    const base = { email: ev.email, providerMessageId, timestamp: _toDate(ev.timestamp) };
    if (ev.event === 'bounce' || ev.event === 'dropped') {
      const hard = ev.type === 'bounce' || ev.event === 'bounce';
      events.push({ ...base, kind: 'bounce', bounceType: hard ? 'hard' : 'soft', detail: ev.reason });
    } else if (ev.event === 'spamreport') {
      events.push({ ...base, kind: 'complaint', detail: 'spamreport' });
    } else if (ev.event === 'delivered') {
      events.push({ ...base, kind: 'delivered', detail: ev.response || null });
    } else if (ev.event === 'open') {
      events.push({ ...base, kind: 'opened', detail: null });
    } else if (ev.event === 'deferred') {
      // Transient — not a delivery outcome yet.
      continue;
    }
  }
  return events;
}

function _parseGeneric(body) {
  // The format formerly accepted by /api/email-provider-webhook/callback:
  // { provider, providerMessageId, eventType, email?, schoolId?, studentId?, reason?, timestamp? }
  const arr = Array.isArray(body) ? body : [body];
  const events = [];
  for (const ev of arr) {
    if (!ev || typeof ev !== 'object') continue;
    const kind = GENERIC_KINDS[ev.eventType];
    if (!kind) continue;
    events.push({
      kind,
      email: ev.email || ev.recipient || null,
      bounceType: kind === 'bounce' ? (ev.bounceType === 'soft' ? 'soft' : 'hard') : undefined,
      detail: ev.reason || null,
      providerMessageId: ev.providerMessageId || null,
      timestamp: _toDate(ev.timestamp),
      raw: ev,
    });
  }
  return events;
}

/**
 * Normalise a provider payload into a list of events.
 *
 * @param {'ses'|'sendgrid'|'generic'} provider
 * @param {*} body
 * @returns {Array<object>}
 */
function parseEvents(provider, body) {
  if (provider === 'ses') return _parseSes(body);
  if (provider === 'sendgrid') return _parseSendGrid(body);
  if (provider === 'generic') return _parseGeneric(body);
  return [];
}

/**
 * Apply normalised events: suppression list + EmailDelivery status.
 *
 * @param {string} provider
 * @param {Array<object>} events
 * @returns {Promise<{processed: number, suppressed: number, deliveryUpdates: number}>}
 */
async function processEvents(provider, events) {
  // Required lazily: emailDeliveryService pulls in models, which this module
  // must not load at require time (it is required by the email send path).
  const { handleEmailProviderEvent } = require('../emailDeliveryService');

  let suppressed = 0;
  let deliveryUpdates = 0;

  for (const ev of events) {
    if (ev.email && ev.kind === 'bounce') {
      await suppressionList.recordBounce(ev.email, { bounceType: ev.bounceType, source: provider, detail: ev.detail });
      suppressed++;
    } else if (ev.email && ev.kind === 'complaint') {
      await suppressionList.recordComplaint(ev.email, { source: provider, detail: ev.detail });
      suppressed++;
    }

    if (ev.providerMessageId) {
      const raw = ev.raw || {};
      await handleEmailProviderEvent({
        ...raw,
        provider: raw.provider || provider,
        providerMessageId: ev.providerMessageId,
        eventType: DELIVERY_EVENT_TYPES[ev.kind],
        timestamp: ev.timestamp ? ev.timestamp.toISOString() : undefined,
        reason: ev.detail || raw.reason || null,
        payload: raw.payload || null,
      });
      deliveryUpdates++;
    }
  }

  logger.info('Processed email provider events', {
    provider, events: events.length, suppressed, deliveryUpdates,
  });
  return { processed: events.length, suppressed, deliveryUpdates };
}

module.exports = { parseEvents, processEvents };
