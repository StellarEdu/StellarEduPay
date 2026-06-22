'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const receiptSchema = new mongoose.Schema(
  {
    txHash:              { type: String, required: true, unique: true, index: true },
    studentId:           { type: String, required: true, index: true },
    studentName:         { type: String, default: null },
    schoolId:            { type: String, required: true, index: true },
    schoolName:          { type: String, default: null },
    amount:              { type: Number, required: true },
    assetCode:           { type: String, default: 'XLM' },
    feeAmount:           { type: Number, default: null },
    feeValidationStatus: { type: String, enum: ['valid', 'overpaid', 'underpaid', 'unknown'], default: 'unknown' },
    memo:                { type: String, default: null },
    confirmedAt:         { type: Date, required: true },
    issuedAt:            { type: Date, default: Date.now },
  },
  { timestamps: true }
);

receiptSchema.plugin(tenantScope, { modelName: 'Receipt' });

module.exports = mongoose.model('Receipt', receiptSchema);
