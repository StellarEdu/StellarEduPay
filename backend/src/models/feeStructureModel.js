'use strict';

const mongoose = require('mongoose');
const softDelete = require('../utils/softDelete');
const tenantScope = require('../plugins/tenantScope');

const feeStructureSchema = new mongoose.Schema(
  {
    schoolId:     { type: String, required: true, index: true },
    className:    { type: String, required: true },
    feeAmount:    { type: Number, required: true, min: [0, 'Fee amount cannot be negative'] },
    /**
     * Currency/asset `feeAmount` is denominated in (Issue #1974).
     * Either an accepted asset code (e.g. 'USDC', 'XLM') or an ISO fiat code.
     * Defaults from `school.feeCurrency` when not supplied.
     */
    feeCurrency: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },
    description:  { type: String, default: '' },
    academicYear: { type: String, default: () => new Date().getUTCFullYear().toString() },
    /**
     * Optional reference to an AcademicPeriod (Issue #1569).
     * When set, this fee structure belongs to the named term/period so
     * reports and balances can be filtered per period.
     */
    periodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AcademicPeriod',
      default: null,
      index: true,
    },
    isActive:        { type: Boolean, default: true, index: true },
    paymentDeadline: { type: Date, default: null },
  },
  { timestamps: true }
);

// Keep historical structures while allowing exactly one active structure for
// a class. The matching migration replaces the legacy unconditional index.
feeStructureSchema.index(
  { schoolId: 1, className: 1 },
  {
    name: 'uniq_active_fee_structure_per_class',
    unique: true,
    partialFilterExpression: { isActive: true },
  }
);
feeStructureSchema.index({ schoolId: 1, isActive: 1 });
feeStructureSchema.plugin(softDelete);
feeStructureSchema.plugin(tenantScope, { modelName: 'FeeStructure' });

module.exports = mongoose.model('FeeStructure', feeStructureSchema);
