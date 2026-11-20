'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

/**
 * ReminderLog — idempotency record for fee reminder deliveries.
 *
 * Before sending a reminder the service claims the (school, student, day) slot
 * by inserting a document here in the 'sending' state. A unique index on
 * (schoolId, studentId, windowStart) guarantees that only one replica wins the
 * race. The row then transitions to 'sent', 'failed' or 'skipped'; 'failed'
 * and stale 'sending' rows can be re-claimed (up to MAX_ATTEMPTS_PER_DAY).
 *
 * The TTL index on createdAt auto-purges records older than the default
 * TTL (90 days) so the collection does not grow unbounded.
 */
const reminderLogSchema = new mongoose.Schema(
  {
    schoolId:    { type: String, required: true },
    studentId:   { type: String, required: true },

    /**
     * Start of the idempotency window in the school's local timezone.
     * Computed as midnight (00:00:00.000) of the current day in the
     * school's timezone.  At most one reminder is sent per student per
     * calendar day regardless of how many replicas fire or restarts occur.
     */
    windowStart: { type: Date, required: true },

    sentAt:      { type: Date, default: Date.now },

    /**
     * Delivery state machine (#1997):
     *   sending — slot claimed, send in flight (or crashed mid-send)
     *   sent    — at least one channel delivered
     *   failed  — send threw; the slot may be re-claimed until MAX_ATTEMPTS_PER_DAY
     *   skipped — no channel delivered and no error (e.g. provider disabled)
     */
    status: {
      type: String,
      enum: ['sending', 'sent', 'skipped', 'failed'],
      default: 'sending',
    },

    /** Number of send attempts made for this (school, student, day) slot. */
    attempts: { type: Number, default: 1 },

    /** When the current attempt was claimed — used to detect stale 'sending' rows. */
    claimedAt: { type: Date, default: Date.now },

    error: { type: String, default: null },

    channels: {
      type: [String],
      enum: ['email', 'sms', 'whatsapp'],
      default: [],
    },

    escalationLevel: { type: Number, default: 1 },
  },
  {
    timestamps: true,
  }
);

// Idempotency: at most one reminder per student per day
reminderLogSchema.index(
  { schoolId: 1, studentId: 1, windowStart: 1 },
  { unique: true }
);

// Dashboard: surface failed reminder deliveries per school
reminderLogSchema.index({ schoolId: 1, status: 1, createdAt: -1 });

// TTL: auto-purge after 90 days (configurable via env)
const TTL_SECONDS = parseInt(process.env.REMINDER_LOG_TTL_SECONDS, 10) || 90 * 24 * 60 * 60;
reminderLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: TTL_SECONDS }
);

reminderLogSchema.plugin(tenantScope, { modelName: 'ReminderLog' });

module.exports = mongoose.model('ReminderLog', reminderLogSchema);
