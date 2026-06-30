'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

/**
 * ReminderLog — idempotency record for fee reminder deliveries.
 *
 * Before sending a reminder the service attempts to insert a document here.
 * A unique index on (schoolId, studentId, windowStart) guarantees that only
 * one replica wins the race; duplicates are silently skipped.
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

    status: {
      type: String,
      enum: ['sent', 'skipped', 'failed'],
      default: 'sent',
    },

    error: { type: String, default: null },
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

// TTL: auto-purge after 90 days (configurable via env)
const TTL_SECONDS = parseInt(process.env.REMINDER_LOG_TTL_SECONDS, 10) || 90 * 24 * 60 * 60;
reminderLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: TTL_SECONDS }
);

reminderLogSchema.plugin(tenantScope, { modelName: 'ReminderLog' });

module.exports = mongoose.model('ReminderLog', reminderLogSchema);
