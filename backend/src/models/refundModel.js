'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const refundSchema = new mongoose.Schema(
  {
    schoolId:       { type: String, required: true, index: true },
    originalTxHash: { type: String, required: true, index: true },
    studentId:      { type: String, required: true, index: true },

    refundTxHash:   { type: String, default: null, unique: true, sparse: true, index: true },
    // Amount being refunded — may be less than the original payment amount for
    // partial refunds (Issue #1567). Must be > 0 and ≤ payment.amount.
    amount:         { type: Number, required: true },

    status: {
      type: String,
      enum: [
        'approval_pending',  // initiated, awaiting two-person approval
        'pending',           // approved, awaiting on-chain execution
        'submitted',         // submitted to Stellar, awaiting confirmation
        'confirmed',         // on-chain confirmation received — terminal success
        'rejected',          // rejected by approver — terminal non-success
        'failed',            // technical failure — terminal error
      ],
      default: 'approval_pending',
      index: true,
    },

    reason:         { type: String, required: true, trim: true, maxlength: 1000 },

    // Structured principal IDs for two-person approval (Issue #1565).
    // Stored as { userId, displayName } to ensure unambiguous identity
    // comparison and prevent the 'super_admin' collapse bug.
    initiatedBy:    {
      userId:      { type: String, required: true },
      displayName: { type: String, required: true },
    },
    approvedBy:     {
      userId:      { type: String, default: null },
      displayName: { type: String, default: null },
    },

    // Rejection fields (Issue #1567 / #1564).
    rejectedBy:       {
      userId:      { type: String, default: null },
      displayName: { type: String, default: null },
    },
    rejectedAt:       { type: Date, default: null },
    rejectionReason:  { type: String, default: null, maxlength: 1000 },

    confirmedAt:    { type: Date, default: null },
    approvedAt:     { type: Date, default: null },
    failedAt:       { type: Date, default: null },
    failureReason:  { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Standard compound indexes.
refundSchema.index({ schoolId: 1, originalTxHash: 1 });
refundSchema.index({ schoolId: 1, studentId: 1 });
refundSchema.index({ schoolId: 1, status: 1 });
refundSchema.index({ schoolId: 1, createdAt: -1 });

// Issue #1566 — Unique partial index: only one active (non-terminal) refund is
// allowed per payment. This provides correctness even if the Redis lock expires
// between writes.  'rejected' and 'failed' are terminal states that allow a
// new refund to be started.
//
// Equivalent to:
//   db.refunds.createIndex(
//     { schoolId: 1, originalTxHash: 1 },
//     { unique: true, partialFilterExpression: {
//         status: { $in: ['approval_pending', 'pending', 'submitted', 'confirmed'] }
//     }}
//   )
refundSchema.index(
  { schoolId: 1, originalTxHash: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['approval_pending', 'pending', 'submitted', 'confirmed'] },
    },
    name: 'unique_active_refund_per_payment',
  }
);

refundSchema.plugin(tenantScope, { modelName: 'Refund' });

module.exports = mongoose.model('Refund', refundSchema);
