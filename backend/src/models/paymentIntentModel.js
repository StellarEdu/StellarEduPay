"use strict";

const mongoose = require("mongoose");
const tenantScope = require('../plugins/tenantScope');

const paymentIntentSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true },
    amount: { type: Number, required: true },
    feeCategory: { type: String, default: null },
    memo: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["pending", "completed", "expired"],
      default: "pending",
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

paymentIntentSchema.index({ schoolId: 1, studentId: 1 });
paymentIntentSchema.index({ schoolId: 1, status: 1 });
// Lookup intent by memo during payment sync
paymentIntentSchema.index({ schoolId: 1, memo: 1, status: 1 });
// Cleanup / TTL queries on expired intents
paymentIntentSchema.index({ status: 1, expiresAt: 1 });
// Compound index for active intent lookup: { studentId, schoolId, expiresAt }
// Optimizes createPaymentIntent's findOne query for checking existing active intents
paymentIntentSchema.index({ studentId: 1, schoolId: 1, expiresAt: 1 });
// TTL index — MongoDB automatically deletes documents after PAYMENT_INTENT_TTL_SECONDS.
// Default: 86400 seconds (24 hours). Override via PAYMENT_INTENT_TTL_SECONDS env var.
// Migration 006 applies this index to existing collections.
paymentIntentSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: parseInt(process.env.PAYMENT_INTENT_TTL_SECONDS || '86400', 10) }
);

paymentIntentSchema.plugin(tenantScope, { modelName: 'PaymentIntent' });

module.exports = mongoose.model("PaymentIntent", paymentIntentSchema);
