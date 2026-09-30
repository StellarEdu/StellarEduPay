'use strict';

const PaymentPlan = require('../models/paymentPlanModel');
const Student = require('../models/studentModel');
const { logAudit } = require('../services/auditService');

async function createPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;
    const { installments } = req.body;

    if (!Array.isArray(installments) || installments.length === 0) {
      return res.status(400).json({ error: 'At least one installment is required', code: 'VALIDATION_ERROR' });
    }

    const student = await Student.findOne({ schoolId, studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    const totalAmount = installments.reduce((sum, inst) => sum + inst.amount, 0);

    const plan = await PaymentPlan.create({
      schoolId,
      studentId,
      totalAmount,
      installments: installments.map(inst => ({
        amount: inst.amount,
        dueDate: new Date(inst.dueDate),
        paid: false,
        paidAmount: 0,
        paymentTxHashes: [],
      })),
    });

    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'payment_plan_create',
        performedBy: req.auditContext.performedBy,
        targetId: studentId,
        targetType: 'payment_plan',
        details: { totalAmount, installmentCount: installments.length },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
}

async function getPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
    if (!plan) {
      return res.status(404).json({ error: 'Payment plan not found', code: 'NOT_FOUND' });
    }

    res.json(plan);
  } catch (err) {
    next(err);
  }
}

// Allocate a confirmed on-chain payment to the oldest unpaid installments (FIFO).
// Supports partial installment payment and records the settling tx hash per installment.
async function allocatePaymentToPlan(schoolId, studentId, amount, txHash) {
  const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null, status: 'active' });
  if (!plan) return null;

  let remaining = amount;
  for (const installment of plan.installments) {
    if (remaining <= 0) break;
    const outstanding = installment.amount - (installment.paidAmount || 0);
    if (outstanding <= 0) continue;

    const applied = Math.min(remaining, outstanding);
    installment.paidAmount = (installment.paidAmount || 0) + applied;
    remaining -= applied;

    if (txHash) {
      installment.paymentTxHashes = installment.paymentTxHashes || [];
      installment.paymentTxHashes.push(txHash);
    }

    if (installment.paidAmount >= installment.amount) {
      installment.paid = true;
      installment.paidAt = new Date();
    }
  }

  await plan.save();
  return plan;
}

async function updateInstallmentStatus(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId, installmentIndex } = req.params;
    const { paid, paidAmount, reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'A reference is required for manual settlements', code: 'VALIDATION_ERROR' });
    }

    const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
    if (!plan) {
      return res.status(404).json({ error: 'Payment plan not found', code: 'NOT_FOUND' });
    }

    if (installmentIndex < 0 || installmentIndex >= plan.installments.length) {
      return res.status(400).json({ error: 'Invalid installment index', code: 'VALIDATION_ERROR' });
    }

    const installment = plan.installments[installmentIndex];
    installment.paid = paid;
    // Reconcile against the installment amount rather than trusting the request body.
    installment.paidAmount = paid ? installment.amount : 0;
    if (paid) {
      installment.paidAt = new Date();
    }

    await plan.save();

    await logAudit({
      schoolId,
      action: 'installment_update',
      performedBy: req.auditContext ? req.auditContext.performedBy : undefined,
      targetId: studentId,
      targetType: 'payment_plan',
      details: { installmentIndex, paid, paidAmount: installment.paidAmount, reference },
      result: 'success',
      ipAddress: req.auditContext ? req.auditContext.ipAddress : undefined,
      userAgent: req.auditContext ? req.auditContext.userAgent : undefined,
    });

    res.json(plan);
  } catch (err) {
    next(err);
  }
}

async function cancelPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
    if (!plan) {
      return res.status(404).json({ error: 'Payment plan not found', code: 'NOT_FOUND' });
    }

    plan.status = 'cancelled';
    plan.deletedAt = new Date();
    await plan.save();

    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'payment_plan_cancel',
        performedBy: req.auditContext.performedBy,
        targetId: studentId,
        targetType: 'payment_plan',
        details: {},
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ message: 'Payment plan cancelled' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPaymentPlan,
  getPaymentPlan,
  updateInstallmentStatus,
  cancelPaymentPlan,
  allocatePaymentToPlan,
};
