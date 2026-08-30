'use strict';

const mongoose = require('mongoose');

/**
 * WebhookDelivery — full delivery log for every webhook attempt.
 *
 * Each document represents ONE delivery attempt (initial or retry) of a
 * webhook payload to a WebhookEndpoint. Records are auto-expired after
 * WEBHOOK_DELIVERY_TTL_SECONDS (default 90 days = 7 776 000 s).
 *
 * Replaces the old replay-only WebhookDelivery schema (which stored only
 * deliveryId + receivedAt). Replay protection is now handled by the
 * in-process nonce store and Redis in webhookService.js.
 *
 * Fields:
 *   endpointId    — ref to the WebhookEndpoint that was targeted
 *   schoolId      — denormalised for fast per-school queries without a join
 *   deliveryId    — UUID assigned at first attempt; shared across retries of
 *                   the same logical delivery
 *   event         — event type string (e.g. 'payment.confirmed')
 *   payload       — the filtered JSON body that was sent (post-PII filtering)
 *   statusCode    — HTTP response status code (null if the request failed
 *                   at the network layer)
 *   responseBody  — first 1 KB of the response body (truncated)
 *   success       — true if statusCode is in the 2xx range
 *   attemptCount  — 1-indexed attempt number (1 = first try, 2 = first retry…)
 *   durationMs    — round-trip time in milliseconds
 *   error         — error message when the request failed at the transport layer
 *   lastAttemptAt — timestamp of this specific attempt
 */
const webhookDeliverySchema = new mongoose.Schema(
  {
    endpointId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WebhookEndpoint',
      required: true,
      index: true,
    },
    schoolId: {
      type: String,
      required: true,
      index: true,
    },
    deliveryId: {
      type: String,
      required: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    statusCode: {
      type: Number,
      default: null,
    },
    responseBody: {
      type: String,
      default: null,
      maxlength: 1024, // cap at 1 KB
    },
    success: {
      type: Boolean,
      required: true,
      index: true,
    },
    attemptCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    durationMs: {
      type: Number,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
    lastAttemptAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Fast per-endpoint history queries (most recent first)
webhookDeliverySchema.index({ endpointId: 1, createdAt: -1 });
// Fast per-school history queries
webhookDeliverySchema.index({ schoolId: 1, createdAt: -1 });
// Dead-letter count query: success=false + attemptCount >= maxAttempts
webhookDeliverySchema.index({ schoolId: 1, success: 1, attemptCount: 1 });

// Auto-expire after 90 days.
//
// WEBHOOK_DELIVERY_RETENTION_DAYS is the documented knob; the older
// WEBHOOK_DELIVERY_TTL_SECONDS still wins when set, so a deployment that
// already configured it does not silently change retention on upgrade.
const DEFAULT_RETENTION_DAYS = 90;

function resolveTtlSeconds() {
  const seconds = parseInt(process.env.WEBHOOK_DELIVERY_TTL_SECONDS, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;

  const days = parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS, 10);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  return retentionDays * 24 * 60 * 60;
}

const TTL_SECONDS = resolveTtlSeconds();
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

const WebhookDelivery = mongoose.model('WebhookDelivery', webhookDeliverySchema);

module.exports = WebhookDelivery;
module.exports.TTL_SECONDS = TTL_SECONDS;
module.exports.DEFAULT_RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
module.exports.resolveTtlSeconds = resolveTtlSeconds;
