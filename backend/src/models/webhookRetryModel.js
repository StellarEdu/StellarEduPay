'use strict';

const mongoose = require('mongoose');

/**
 * Webhook Retry Queue model — tracks failed webhook deliveries for retry.
 *
 * Lifecycle:
 *   pending → processing (atomically claimed by a worker)
 *             → succeeded | pending (next attempt) | failed (exhausted)
 *
 * The 'processing' state is used for atomic lease claiming (Issue #74).
 * A worker uses findOneAndUpdate to flip status from pending → processing
 * in a single atomic operation, guaranteeing only one worker delivers each
 * retry even when multiple replicas run concurrently.
 *
 * Stuck leases: if a worker crashes mid-delivery, the document stays
 * 'processing' forever. processPendingRetries() recovers these by resetting
 * any 'processing' document whose leasedAt is older than LEASE_TIMEOUT_MS
 * back to 'pending' before picking up new work.
 */
const webhookRetrySchema = new mongoose.Schema(
  {
    // Webhook configuration
    url: { type: String, required: true, index: true },
    event: { type: String, required: true, enum: ['payment.confirmed', 'payment.pending', 'payment.failed', 'payment.suspicious', 'payment.refunded'] },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    // schoolId is stored so the signing secret can be resolved from the School
    // document at send time rather than persisted on this document (Issue #75).
    schoolId: { type: String, default: null, index: true },

    // Delivery tracking for deduplication
    deliveryId: { type: String, required: true, index: true, unique: true },

    // Correlation ID for tracing this delivery back to its originating payment.
    correlationId: { type: String, default: null, index: true },

    // #865: back-reference to the WebhookEndpoint (null for legacy deliveries)
    endpointId: { type: mongoose.Schema.Types.ObjectId, ref: 'WebhookEndpoint', default: null, index: true },

    // #865: denormalised schoolId for metrics and dead-letter queries
    schoolId: { type: String, default: null, index: true },

    // #1815: per-endpoint sequence allocated when the delivery was first made.
    // Retries send the same value so consumers can order deliveries.
    sequence: { type: Number, default: null },

    // Retry tracking
    status: {
      type: String,
      // 'processing' is the atomic in-progress claim state (Issue #74).
      // It is transient: a worker sets it before sending and immediately
      // transitions to succeeded, pending (next attempt), or failed.
      enum: ['pending', 'processing', 'succeeded', 'failed'],
      default: 'pending',
      index: true,
    },
    attemptCount: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },

    // Lease fields for atomic claiming (Issue #74).
    // leasedAt: when this worker claimed the document.
    // leasedBy: identifier for the worker/process that holds the lease
    //           (e.g. hostname:pid or UUID). Useful for diagnostics.
    leasedAt: { type: Date, default: null },
    leasedBy: { type: String, default: null },

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
// Index for stuck-lease recovery: quickly find processing docs with old leasedAt
webhookRetrySchema.index({ status: 1, leasedAt: 1 });

module.exports = mongoose.model('WebhookRetry', webhookRetrySchema);
