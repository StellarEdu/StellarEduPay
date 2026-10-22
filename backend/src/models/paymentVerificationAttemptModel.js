const mongoose = require('mongoose');

const paymentVerificationAttemptSchema = new mongoose.Schema(
  {
    txHash: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    schoolId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      default: '',
      trim: true,
    },
    attemptedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    collection: 'payment_verification_attempts',
  }
);

// Compound index to quickly look up attempts for a given transaction within a school.
paymentVerificationAttemptSchema.index({ schoolId: 1, txHash: 1, attemptedAt: -1 });

// TTL index: automatically purge audit records after 30 days.
paymentVerificationAttemptSchema.index(
  { attemptedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);

module.exports = mongoose.model(
  'PaymentVerificationAttempt',
  paymentVerificationAttemptSchema
);