'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const studentFeeHistorySchema = new mongoose.Schema(
  {
    schoolId:        { type: String, required: true, index: true },
    studentId:       { type: String, required: true, index: true },
    category:        { type: String, required: true },
    amount:          { type: Number, required: true },
    paid:            { type: Boolean, default: false },
    totalPaid:       { type: Number, default: 0 },
    remainingBalance:{ type: Number, default: null },
    paymentDeadline: { type: Date,   default: null },
    archivedAt:      { type: Date,   default: Date.now, index: true },
  },
  { timestamps: true }
);

studentFeeHistorySchema.index({ studentId: 1, schoolId: 1 });

studentFeeHistorySchema.plugin(tenantScope, { modelName: 'StudentFeeHistory' });

module.exports = mongoose.model('StudentFeeHistory', studentFeeHistorySchema);
