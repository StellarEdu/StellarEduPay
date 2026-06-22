const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const feeAdjustmentRuleSchema = new mongoose.Schema({
  schoolId: { type: String, required: true, index: true },
  name: { type: String, required: true }, // e.g., "Early Bird Discount", "Late Penalty"
  type: { 
    type: String, 
    enum: ['discount_percentage', 'discount_fixed', 'penalty_percentage', 'penalty_fixed', 'waiver'], 
    required: true 
  },
  value: { type: Number, required: true }, // e.g., 10 for 10%, 500 for ₦500
  conditions: {
    studentClass: [{ type: String }],           // e.g., ["JSS1", "JSS2"]
    academicYear: { type: String },
    paymentBefore: { type: Date },              // early bird
    paymentAfter: { type: Date },               // late penalty
    minAmount: { type: Number },
    maxAmount: { type: Number },
    // You can extend with more conditions (studentId list, grade, etc.)
  },
  isActive: { type: Boolean, default: true },
  priority: { type: Number, default: 10 },      // higher priority applied first
  description: { type: String }
}, { timestamps: true });

feeAdjustmentRuleSchema.index({ schoolId: 1, name: 1 }, { unique: true });

feeAdjustmentRuleSchema.plugin(tenantScope, { modelName: 'FeeAdjustmentRule' });

module.exports = mongoose.model('FeeAdjustmentRule', feeAdjustmentRuleSchema);