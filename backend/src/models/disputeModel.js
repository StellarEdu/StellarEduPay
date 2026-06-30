'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

/**
 * Dispute model — tracks disputed payments and their resolution lifecycle.
 *
 * A dispute is a separate entity that references a Payment by txHash.
 * This avoids mutating the immutable payment audit trail.
 *
 * Lifecycle: open → under_review → resolved | rejected
 */
const disputeSchema = new mongoose.Schema(
  {
    // Tenant isolation — all queries must include schoolId
    schoolId:    { type: String, required: true, index: true },

    // Reference to the disputed payment (txHash is the stable public identifier)
    txHash:      { type: String, required: true, index: true },
    studentId:   { type: String, required: true, index: true },

    // Who raised the dispute and why
    raisedBy:    { type: String, required: true, trim: true, maxlength: 200 },   // e.g. parent name / admin ID
    reason:      { type: String, required: true, trim: true, maxlength: 1000 },   // free-text description

    status: {
      type: String,
      enum: ['open', 'under_review', 'resolved', 'rejected'],
      default: 'open',
      index: true,
    },

    // Resolution details — populated when status moves to resolved/rejected
    resolvedBy:   { type: String, default: null },
    resolutionNote: { type: String, default: null },
    resolvedAt:   { type: Date, default: null },

    // Hold tracking — records whether the disputeHold was lifted on this
    // student when the dispute closed. Always null while the dispute is still
    // open or under_review.
    holdLifted:   { type: Boolean, default: null },
  },
  {
    timestamps: true, // createdAt = when dispute was raised, updatedAt = last change
  }
);

// Compound indexes for common query patterns
disputeSchema.index({ schoolId: 1, status: 1 });
disputeSchema.index({ schoolId: 1, txHash: 1 });
disputeSchema.index({ schoolId: 1, studentId: 1 });

// One open/under_review dispute per payment per school — prevent duplicate open disputes
disputeSchema.index(
  { schoolId: 1, txHash: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['open', 'under_review'] } },
  }
);

disputeSchema.plugin(tenantScope, { modelName: 'Dispute' });

module.exports = mongoose.model('Dispute', disputeSchema);
