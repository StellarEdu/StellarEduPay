'use strict';

const mongoose = require('mongoose');

/**
 * Outbox model — transactional outbox pattern for reliable event delivery.
 *
 * Schema additions (issue #1646):
 *   status        — replaces the old boolean `processed`/`deadLettered` flags.
 *                   Values: 'pending' | 'processing' | 'completed' | 'dead_letter'
 *   lockedUntil   — lease expiry timestamp; compared atomically in the claim
 *                   query so only one dispatcher (replica or tick) processes
 *                   each event at a time.
 *   lockedBy      — instance ID of the replica that currently holds the lease,
 *                   useful for debugging stuck leases.
 *   deliveredTo   — array of listener names that have already received this
 *                   event successfully. Retry passes only to listeners NOT in
 *                   this array, preventing re-delivery to successful listeners.
 *   nextAttemptAt — earliest time the event may be retried; enforces
 *                   exponential backoff between attempts.
 *   retryCount    — number of dispatch attempts so far (across all listeners).
 *   lastError     — most recent error message, stored for debugging.
 *
 * Backward-compatibility: the old `processed` and `deadLettered` boolean fields
 * are kept as virtual-equivalent defaults so any code that still reads them
 * via plain find() gets sensible values. New code must use `status`.
 */
const outboxSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    eventId:       { type: String, required: true, unique: true, index: true },
    eventType:     { type: String, required: true, index: true },
    aggregateId:   { type: String, required: true, index: true },
    aggregateType: { type: String, required: true },
    payload:       { type: mongoose.Schema.Types.Mixed, required: true },

    // ── Lifecycle status ──────────────────────────────────────────────────────
    // 'pending'     — waiting to be dispatched (or waiting for next retry)
    // 'processing'  — currently held by a dispatcher (within lease window)
    // 'completed'   — all listeners received the event successfully
    // 'dead_letter' — exhausted retry budget; needs manual inspection
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'dead_letter'],
      default: 'pending',
      index: true,
    },

    // ── Atomic lease (anti-duplication across replicas) ───────────────────────
    // The dispatcher claims an event with:
    //   findOneAndUpdate(
    //     { status: 'pending', nextAttemptAt: { $lte: now }, lockedUntil: { $lt: now } },
    //     { $set: { status: 'processing', lockedUntil: now + LEASE_MS, lockedBy: instanceId } }
    //   )
    // A subsequent replica that tries to claim the same event gets null back
    // because `status` is no longer 'pending'.
    lockedUntil: { type: Date, default: () => new Date(0) },
    lockedBy:    { type: String, default: null },

    // ── Per-listener delivery tracking ────────────────────────────────────────
    // Populated incrementally as each listener confirms delivery. On retry, the
    // dispatcher only invokes listeners NOT already present in this array,
    // preventing duplicate delivery to listeners that already succeeded.
    deliveredTo: { type: [String], default: [] },

    // ── Retry budget ─────────────────────────────────────────────────────────
    nextAttemptAt: { type: Date, default: () => new Date() },
    retryCount:    { type: Number, default: 0 },
    lastError:     { type: String, default: null },

    // ── Backward-compat: kept so old reads don't get undefined ────────────────
    // Derived from `status` on read; no longer the source of truth.
    processedAt:      { type: Date, default: null },
    deadLetteredAt:   { type: Date, default: null },
    deadLetterReason: { type: String, default: null },

    // #1636: W3C trace context ({ traceparent, tracestate }) of the operation
    // that wrote the event, so dispatch continues the same trace.
    traceContext:     { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  {
    timestamps: true,
  }
);

outboxSchema.pre('validate', function captureTraceContext(next) {
  if (this.isNew && !this.traceContext) {
    const traceContext = require('../tracing').injectTraceContext();
    if (traceContext) this.traceContext = traceContext;
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────

// Primary dispatch query: find pending events ready for their next attempt.
outboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

// Lag metric query: find the oldest pending/processing event.
outboxSchema.index({ status: 1, createdAt: 1 });

// Legacy index retained for any existing query consumers.
outboxSchema.index({ eventType: 1, status: 1 });

// ── Virtual back-compat properties ───────────────────────────────────────────

outboxSchema.virtual('processed').get(function () {
  return this.status === 'completed';
});

outboxSchema.virtual('deadLettered').get(function () {
  return this.status === 'dead_letter';
});

module.exports = mongoose.model('Outbox', outboxSchema);
