'use strict';

/**
 * UnmatchedPayment — a creditable inflow to a school wallet that could not be
 * attributed to a student (issue #1798).
 *
 * Without this record the money is only visible in a log line that ages out.
 * Each document is unique per { schoolId, txHash, opIndex } so repeated polls
 * and manual syncs of the same transaction never create duplicates.
 */

const mongoose = require('mongoose');

const UNMATCHED_STATUSES = ['open', 'matched', 'refunded', 'ignored'];

const unmatchedPaymentSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    txHash: { type: String, required: true },
    opIndex: { type: Number, required: true, default: 0 },
    amount: { type: String, required: true },
    assetCode: { type: String, default: null },
    memo: { type: String, default: null },
    memoType: { type: String, default: null },
    senderAddress: { type: String, default: null },
    ledger: { type: Number, default: null },
    reason: { type: String, required: true },
    receivedAt: { type: Date, default: Date.now },
    status: { type: String, enum: UNMATCHED_STATUSES, default: 'open', index: true },
    resolvedBy: { type: String, default: null },
    resolution: { type: String, default: null },
  },
  { collection: 'unmatched_payments' },
);

unmatchedPaymentSchema.index({ schoolId: 1, txHash: 1, opIndex: 1 }, { unique: true });

module.exports = mongoose.model('UnmatchedPayment', unmatchedPaymentSchema);
module.exports.UNMATCHED_STATUSES = UNMATCHED_STATUSES;
