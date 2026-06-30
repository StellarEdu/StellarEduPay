'use strict';

/**
 * Email suppression list (Issue #80).
 *
 * Records addresses that must NOT be emailed again because of a hard bounce,
 * spam complaint, manual block, or reminder unsubscribe. The email module
 * consults this list before every send so dropped/abusive addresses are never
 * retried, and it feeds the reminder opt-out flow (Issue #9).
 *
 * Soft bounces are recorded for visibility but do NOT suppress — only `hard`
 * bounces, `complaint`, `manual`, and `unsubscribe` reasons block delivery.
 */

const mongoose = require('mongoose');

const SUPPRESSION_REASONS = ['bounce', 'complaint', 'manual', 'unsubscribe'];
// Reasons that actually block delivery. A soft bounce is reason 'bounce' with
// bounceType 'soft' — recorded but not blocking.
const BLOCKING = new Set(['complaint', 'manual', 'unsubscribe']);

const emailSuppressionSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true, // unique implies a single-field index
      trim: true,
      lowercase: true,
    },
    reason: { type: String, enum: SUPPRESSION_REASONS, required: true },
    // Only meaningful when reason === 'bounce': 'hard' suppresses, 'soft' does not.
    bounceType: { type: String, enum: ['hard', 'soft', null], default: null },
    // Provider/source that reported the event (e.g. 'ses', 'sendgrid', 'admin').
    source: { type: String, default: null },
    // Free-form detail for operators (provider diagnostic code, message, etc.).
    detail: { type: String, default: null },
    suppressedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/**
 * Whether a stored suppression record blocks delivery.
 */
emailSuppressionSchema.methods.isBlocking = function isBlocking() {
  if (BLOCKING.has(this.reason)) return true;
  return this.reason === 'bounce' && this.bounceType === 'hard';
};

emailSuppressionSchema.statics.SUPPRESSION_REASONS = SUPPRESSION_REASONS;

module.exports = mongoose.model('EmailSuppression', emailSuppressionSchema);
