'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const installmentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: [0, 'Installment amount cannot be negative'] },
    dueDate: { type: Date, required: true },
    paid: { type: Boolean, default: false },
    paidAt: { type: Date, default: null },
    paidAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const paymentPlanSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    totalAmount: { type: Number, required: true, min: [0, 'Total amount cannot be negative'] },
    installments: { type: [installmentSchema], required: true, validate: { validator: (v) => v.length > 0, message: 'At least one installment is required' } },
    status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active', index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: null, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual: total paid across all installments
paymentPlanSchema.virtual('totalPaid').get(function () {
  return this.installments.reduce((sum, inst) => sum + (inst.paidAmount || 0), 0);
});

// Virtual: remaining balance
paymentPlanSchema.virtual('remainingBalance').get(function () {
  return Math.max(0, this.totalAmount - this.totalPaid);
});

// Virtual: number of completed installments
paymentPlanSchema.virtual('completedInstallments').get(function () {
  return this.installments.filter(inst => inst.paid).length;
});

// Virtual: is current (no overdue installments)
paymentPlanSchema.virtual('isCurrent').get(function () {
  const now = new Date();
  return !this.installments.some(inst => !inst.paid && inst.dueDate < now);
});

// Virtual: next due date
paymentPlanSchema.virtual('nextDueDate').get(function () {
  const unpaid = this.installments.find(inst => !inst.paid);
  return unpaid ? unpaid.dueDate : null;
});

paymentPlanSchema.plugin(tenantScope, { modelName: 'PaymentPlan' });

module.exports = mongoose.model('PaymentPlan', paymentPlanSchema);
