'use strict';

const mongoose = require('mongoose');
const { encryptWebhookSecret, decryptWebhookSecret } = require('../services/webhookSecretEncryption');

/**
 * Supported webhook event types.
 * Keep this in sync with the event strings used in webhookService.js.
 */
const WEBHOOK_EVENTS = [
  'payment.confirmed',
  'payment.pending',
  'payment.failed',
  'payment.suspicious',
  'payment.refunded',
  'payment.refund_rejected',
  'dispute.created',
  'dispute.under_review',
  'dispute.resolved',
  'dispute.reopened',
  'dispute.sla_breached',
  'refund.initiated',
  'refund.completed',
];

/**
 * Event sent by POST /api/webhook-endpoints/:id/test (#1639). Not
 * subscribable — it is only ever delivered on explicit request.
 */
const TEST_EVENT = 'webhook.test';

/**
 * Events the retired School.webhookUrl delivery path emitted (#1640).
 * Endpoints created by migration 036 or the deprecated
 * POST /api/schools/:slug/webhooks route subscribe to exactly these so
 * integrators keep receiving what they received before.
 */
const LEGACY_SCHOOL_EVENTS = [
  'payment.confirmed',
  'payment.refunded',
  'dispute.created',
  'dispute.under_review',
  'dispute.resolved',
  'dispute.reopened',
];

/**
 * How an endpoint came to exist (#1640).
 *   api                    — created through /api/webhook-endpoints
 *   legacy_school_webhook  — created from School.webhookUrl by migration 036,
 *                            or by the deprecated per-school webhook route
 */
const ENDPOINT_SOURCES = Object.freeze({
  API: 'api',
  LEGACY_SCHOOL_WEBHOOK: 'legacy_school_webhook',
});

/**
 * Signature schemes an endpoint can receive (#1539).
 *   v1 — legacy X-StellarEduPay-Signature (body only; deprecated, sunset via
 *        WEBHOOK_V1_SUNSET).
 *   v2 — X-StellarEduPay-Signature-V2 (timestamp.deliveryId.rawBody).
 */
const SIGNATURE_VERSIONS = ['v1', 'v2'];

/**
 * Default signature versions for endpoints created from now on (#1539).
 * Existing endpoints are backfilled to ['v1', 'v2'] by migration 031.
 */
const DEFAULT_SIGNATURE_VERSIONS = ['v2'];

/**
 * WebhookEndpoint — per-school, per-event webhook subscription.
 *
 * A school may register multiple endpoints. Each endpoint subscribes to one
 * or more event types. The webhookService queries all active endpoints that
 * subscribe to the current event and fires each one independently.
 *
 * Fields:
 *   schoolId          — the owning school (tenant key)
 *   url               — the HTTPS delivery URL (validated at save time)
 *   secret            — per-endpoint HMAC-SHA256 signing secret. Encrypted at
 *                       rest (#1538) and excluded from queries by default
 *                       (select: false) — load it with .select('+secret').
 *   previousSecret    — the secret replaced by the most recent rotation; deliveries
 *                       are additionally signed with it until
 *                       previousSecretExpiresAt so receivers can roll over (#1538).
 *   signatureVersions — which signature headers this endpoint receives (#1539).
 *   eventSequence     — last per-endpoint delivery sequence issued (#1815)
 *   subscribedEvents  — subset of WEBHOOK_EVENTS this endpoint receives
 *   isActive          — when false, the endpoint is skipped on all deliveries
 *   description       — optional human-readable label for admin UIs
 *   createdBy         — userId/email of the operator who registered it
 *   source            — 'api' or 'legacy_school_webhook' (#1640)
 */
const webhookEndpointSchema = new mongoose.Schema(
  {
    schoolId: {
      type: String,
      required: true,
      index: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    secret: {
      type: String,
      required: true,
      select: false,
    },
    previousSecret: {
      type: String,
      default: null,
      select: false,
    },
    previousSecretExpiresAt: {
      type: Date,
      default: null,
    },
    secretRotatedAt: {
      type: Date,
      default: null,
    },
    signatureVersions: {
      type: [{ type: String, enum: SIGNATURE_VERSIONS }],
      default: () => [...DEFAULT_SIGNATURE_VERSIONS],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length > 0;
        },
        message: 'signatureVersions must contain at least one signature version',
      },
    },
    // #1815: last sequence number issued to this endpoint. Incremented
    // atomically per delivery so consumers can detect gaps and reorder.
    eventSequence: { type: Number, default: 0, min: 0 },
    subscribedEvents: {
      type: [String],
      enum: WEBHOOK_EVENTS,
      required: true,
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length > 0;
        },
        message: 'subscribedEvents must contain at least one event type',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    description: {
      type: String,
      default: null,
      trim: true,
    },
    createdBy: {
      type: String,
      default: null,
    },
    source: {
      type: String,
      enum: Object.values(ENDPOINT_SOURCES),
      default: ENDPOINT_SOURCES.API,
    },
  },
  { timestamps: true }
);

// Compound index: look up active endpoints for a given school + event
webhookEndpointSchema.index({ schoolId: 1, subscribedEvents: 1, isActive: 1 });

// Operator report of endpoints still receiving V1 signatures (#1539)
webhookEndpointSchema.index({ signatureVersions: 1, isActive: 1 });

// Lookup of a school's legacy endpoint by the deprecated per-school routes (#1640)
webhookEndpointSchema.index({ schoolId: 1, source: 1 });

// Purge of expired rotation secrets (#1639)
webhookEndpointSchema.index({ previousSecretExpiresAt: 1 }, { sparse: true });

// toJSON: strip the secrets from serialised output (never expose them over API)
webhookEndpointSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.secret;
    delete ret.previousSecret;
    return ret;
  },
});

// ── Secret encryption at rest — Issue #1538 ─────────────────────────────────
// Mirrors School.webhookSecret (Issue #75): encrypt before persisting, decrypt
// transparently after loading. No-ops when WEBHOOK_SECRET_ENCRYPTION_KEY is
// not set so local development keeps working.

webhookEndpointSchema.pre('save', function (next) {
  if (this.isModified('secret') && this.secret != null) {
    this.secret = encryptWebhookSecret(this.secret);
  }
  if (this.isModified('previousSecret') && this.previousSecret != null) {
    this.previousSecret = encryptWebhookSecret(this.previousSecret);
  }
  next();
});

// Re-decrypt after save so the in-memory document keeps exposing plaintext to
// the caller (e.g. to return a freshly generated secret once).
webhookEndpointSchema.post('save', function () {
  if (this.secret != null) this.secret = decryptWebhookSecret(this.secret);
  if (this.previousSecret != null) this.previousSecret = decryptWebhookSecret(this.previousSecret);
});

webhookEndpointSchema.post('init', function () {
  if (this.secret != null) this.secret = decryptWebhookSecret(this.secret);
  if (this.previousSecret != null) this.previousSecret = decryptWebhookSecret(this.previousSecret);
});

/**
 * Decrypt the secret fields of a plain object returned by a .lean() query
 * (post('init') hooks do not run for lean documents). Mutates and returns
 * the object.
 *
 * @param {object|null} ep
 * @returns {object|null}
 */
function decryptLeanEndpoint(ep) {
  if (!ep) return ep;
  if (ep.secret != null) ep.secret = decryptWebhookSecret(ep.secret);
  if (ep.previousSecret != null) ep.previousSecret = decryptWebhookSecret(ep.previousSecret);
  return ep;
}

module.exports = mongoose.model('WebhookEndpoint', webhookEndpointSchema);
module.exports.WEBHOOK_EVENTS = WEBHOOK_EVENTS;
module.exports.TEST_EVENT = TEST_EVENT;
module.exports.LEGACY_SCHOOL_EVENTS = LEGACY_SCHOOL_EVENTS;
module.exports.ENDPOINT_SOURCES = ENDPOINT_SOURCES;
module.exports.SIGNATURE_VERSIONS = SIGNATURE_VERSIONS;
module.exports.DEFAULT_SIGNATURE_VERSIONS = DEFAULT_SIGNATURE_VERSIONS;
module.exports.decryptLeanEndpoint = decryptLeanEndpoint;
