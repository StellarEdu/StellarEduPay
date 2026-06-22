'use strict';

const mongoose = require('mongoose');

/**
 * Webhook Retry Queue model — tracks failed webhook deliveries for retry.
 * 
 * Lifecycle: pending → succeeded | failed (after max retries)
 */
const webhookRetrySchema = new mongoose.Schema(
  {
    // Webhook configuration
    url: { type: String, required: true, index: true },
    event: { type: String, required: true, enum: ['payment.confirmed', 'payment.pending', 'payment.failed', 'payment.suspicious'] },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    secret: { type: String, default: null }, // HMAC secret for re-signing on retry

    // Delivery tracking for deduplication
    deliveryId: { type: String, required: true, index: true, unique: true },

    // Correlation ID for tracing this delivery back to its originating payment.
    correlationId: { type: String, default: null, index: true },

    // Retry tracking
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed'],
      default: 'pending',
      index: true,
    },
    attemptCount: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },

    // Timing
    nextRetryAt: { type: Date, default: () => new Date() },
    lastAttemptAt: { type: Date, default: null },
    succeededAt: { type: Date, default: null },

    // Error tracking
    lastError: { type: String, default: null },
    errorLog: [
      {
        attemptNumber: Number,
        error: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// Index for finding pending retries
webhookRetrySchema.index({ status: 1, nextRetryAt: 1 });
webhookRetrySchema.index({ url: 1, status: 1 });

module.exports = mongoose.model('WebhookRetry', webhookRetrySchema);
