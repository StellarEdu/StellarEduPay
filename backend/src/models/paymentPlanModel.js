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
    // On-chain payments that settled (fully or partially) this installment.
    paymentTxHashes: { type: [String], default: [] },
    // Manual (cash/off-chain) settlement reference, required for manual overrides.
    reference: { type: String, default: null },
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

// Virtual: overdue installments surfaced for reports/dashboard
paymentPlanSchema.virtual('overdueInstallments').get(function () {
  const now = new Date();
  return this.installments.filter(inst => !inst.paid && inst.dueDate < now);
});

// Virtual: next due date (oldest unpaid installment)
paymentPlanSchema.virtual('nextDueDate').get(function () {
  const unpaid = this.installments.find(inst => !inst.paid);
  return unpaid ? unpaid.dueDate : null;
});

// Allocate a confirmed payment to the oldest unpaid installments (FIFO),
// recording the payment tx hash per installment and supporting partial payment.
paymentPlanSchema.methods.applyPayment = function (amount, txHash) {
  let remaining = Number(amount) || 0;
  if (remaining <= 0) return { applied: 0, remaining: 0 };

  const applied = remaining;
  const ordered = [...this.installments].sort((a, b) => a.dueDate - b.dueDate);

  for (const inst of ordered) {
    if (remaining <= 0) break;
    if (inst.paid) continue;

    const outstanding = Math.max(0, inst.amount - (inst.paidAmount || 0));
    if (outstanding <= 0) continue;

    const portion = Math.min(outstanding, remaining);
    inst.paidAmount = (inst.paidAmount || 0) + portion;
    remaining -= portion;

    if (txHash && !inst.paymentTxHashes.includes(txHash)) {
      inst.paymentTxHashes.push(txHash);
    }

    if (inst.paidAmount >= inst.amount) {
      inst.paid = true;
      inst.paidAt = new Date();
    }
  }

  if (this.installments.every(inst => inst.paid)) {
    this.status = 'completed';
  }

  this.updatedAt = new Date();
  return { applied: applied - remaining, remaining };
};

// Manual (cash/off-chain) settlement of a single installment. Requires a
// reference so the override is traceable and can be audited.
paymentPlanSchema.methods.settleInstallmentManually = function (index, { paid, paidAmount, reference } = {}) {
  const inst = this.installments[index];
  if (!inst) throw new Error('Installment not found');
  if (!reference) throw new Error('A reference is required for manual installment settlement');

  inst.reference = reference;

  if (paid) {
    const amount = paidAmount != null ? Number(paidAmount) : inst.amount;
    inst.paidAmount = amount;
    inst.paid = inst.paidAmount >= inst.amount;
    inst.paidAt = new Date();
  } else {
    inst.paid = false;
    inst.paidAmount = 0;
    inst.paidAt = null;
  }

  if (this.installments.every(i => i.paid)) {
    this.status = 'completed';
  } else if (this.status === 'completed') {
    this.status = 'active';
  }

  this.updatedAt = new Date();
  return inst;
};

paymentPlanSchema.plugin(tenantScope, { modelName: 'PaymentPlan' });

module.exports = mongoose.model('PaymentPlan', paymentPlanSchema);
