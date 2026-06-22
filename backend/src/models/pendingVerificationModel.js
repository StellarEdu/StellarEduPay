"use strict";

const mongoose = require("mongoose");
const tenantScope = require('../plugins/tenantScope');

/**
 * Stores transactions that could not be verified due to a Stellar network outage.
 * schoolId is stored so the retry worker can use the correct school's Stellar
 * wallet address when re-attempting verification.
 */
const pendingVerificationSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    txHash: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, default: null },
    // Correlation ID for tracing this job across the async pipeline.
    correlationId: { type: String, default: null, index: true },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ["pending", "processing", "resolved", "dead_letter"],
      default: "pending",
      index: true,
    },
    lastError: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

pendingVerificationSchema.index({ schoolId: 1, status: 1, nextRetryAt: 1 });
// Retry worker: find pending items ready for retry
pendingVerificationSchema.index({ status: 1, nextRetryAt: 1 });
// Efficient retry worker queries: filter by due time and attempt count
pendingVerificationSchema.index({ nextRetryAt: 1, attempts: 1 });
// Multi-school filtering by due time
pendingVerificationSchema.index({ schoolId: 1, nextRetryAt: 1 });

pendingVerificationSchema.plugin(tenantScope, { modelName: 'PendingVerification' });

module.exports = mongoose.model(
  "PendingVerification",
  pendingVerificationSchema,
);
