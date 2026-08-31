'use strict';

const mongoose = require('mongoose');

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
  'dispute.created',
  'dispute.resolved',
  'refund.initiated',
  'refund.completed',
];

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
 *   secret            — per-endpoint HMAC-SHA256 signing secret
 *   subscribedEvents  — subset of WEBHOOK_EVENTS this endpoint receives
 *   isActive          — when false, the endpoint is skipped on all deliveries
 *   description       — optional human-readable label for admin UIs
 *   createdBy         — userId/email of the operator who registered it
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
    },
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
  },
  { timestamps: true }
);

// Compound index: look up active endpoints for a given school + event
webhookEndpointSchema.index({ schoolId: 1, subscribedEvents: 1, isActive: 1 });

// toJSON: strip the secret from serialised output (never expose it over API)
webhookEndpointSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.secret;
    return ret;
  },
});

module.exports = mongoose.model('WebhookEndpoint', webhookEndpointSchema);
module.exports.WEBHOOK_EVENTS = WEBHOOK_EVENTS;
