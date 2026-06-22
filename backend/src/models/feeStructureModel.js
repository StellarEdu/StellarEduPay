'use strict';

const mongoose = require('mongoose');
const softDelete = require('../utils/softDelete');
const tenantScope = require('../plugins/tenantScope');

const feeStructureSchema = new mongoose.Schema(
  {
    schoolId:     { type: String, required: true, index: true },
    className:    { type: String, required: true },
    feeAmount:    { type: Number, required: true, min: [0, 'Fee amount cannot be negative'] },
    description:  { type: String, default: '' },
    academicYear: { type: String, default: () => new Date().getUTCFullYear().toString() },
    isActive:        { type: Boolean, default: true, index: true },
    paymentDeadline: { type: Date, default: null },
  },
  { timestamps: true }
);

// className must be unique per school (was globally unique before)
feeStructureSchema.index({ schoolId: 1, className: 1 }, { unique: true });
feeStructureSchema.index({ schoolId: 1, className: 1, isActive: 1 });
feeStructureSchema.index({ schoolId: 1, isActive: 1 });
feeStructureSchema.plugin(softDelete);
feeStructureSchema.plugin(tenantScope, { modelName: 'FeeStructure' });

module.exports = mongoose.model('FeeStructure', feeStructureSchema);
