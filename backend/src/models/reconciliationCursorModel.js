'use strict';

const mongoose = require('mongoose');

/**
 * ReconciliationCursor — tracks progress through a reconciliation cycle.
 *
 * Used to resume reconciliation from the last processed student if the
 * reconciliation job crashes or is interrupted mid-run. This allows large
 * reconciliation batches to continue from where they left off rather than
 * restarting from the beginning.
 *
 * Only one active cursor per schoolId at a time. If a new reconciliation
 * starts while one is in progress, the old cursor is overwritten.
 */
const reconciliationCursorSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, unique: true, sparse: true },

    // Last student ID processed in this cycle (for resuming on crash)
    lastProcessedStudentId: { type: String, default: null },

    // Total students processed so far in this cycle
    processedCount: { type: Number, default: 0 },

    // Total students that failed in this cycle
    failedCount: { type: Number, default: 0 },

    // Timestamp when this cursor was started (identifies the current cycle)
    cycleStartedAt: { type: Date, required: true },

    // Last update time (for cleanup of stale cursors)
    lastUpdatedAt: { type: Date, default: Date.now },

    status: {
      type: String,
      enum: ['in_progress', 'completed', 'failed'],
      default: 'in_progress',
    },
  },
  {
    timestamps: true,
  }
);

// TTL index: auto-delete cursors older than 48 hours to prevent buildup
reconciliationCursorSchema.index(
  { lastUpdatedAt: 1 },
  { expireAfterSeconds: 48 * 60 * 60 }
);

module.exports = mongoose.model('ReconciliationCursor', reconciliationCursorSchema);
