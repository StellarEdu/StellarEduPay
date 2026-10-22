'use strict';

const Joi = require('joi');
const PaymentPlan = require('../models/paymentPlanModel');
const Student = require('../models/studentModel');
const { logAudit } = require('../services/auditService');
const money = require('../utils/money');

const MAX_INSTALLMENTS = 24;

const createPaymentPlanSchema = Joi.object({
  installments: Joi.array()
    .min(1)
    .max(MAX_INSTALLMENTS)
    .items(
      Joi.object({
        amount: Joi.number().positive().precision(7).required(),
        dueDate: Joi.date().iso().greater('now').required(),
      })
    )
    .required()
    .custom((installments, helpers) => {
      for (let i = 1; i < installments.length; i += 1) {
        const prev = new Date(installments[i - 1].dueDate).getTime();
        const curr = new Date(installments[i].dueDate).getTime();
        if (curr <= prev) {
          return helpers.error('array.dueDatesAscending', { index: i });
        }
      }
      return installments;
    })
    .messages({
      'array.base': 'installments must be an array',
      'array.min': 'At least one installment is required',
      'array.max': `At most ${MAX_INSTALLMENTS} installments are allowed`,
      'array.dueDatesAscending': 'Installment due dates must be strictly ascending (index {{#index}})',
      'number.positive': 'Installment amount must be greater than zero',
      'number.precision': 'Installment amount must have at most 7 decimal places',
      'date.greater': 'Installment due date must be in the future',
      'date.format': 'Installment due date must be a valid ISO date',
    }),
  allowPartialPlan: Joi.boolean().default(false),
});

function formatValidationErrors(error) {
  return error.details.map(detail => ({
    field: detail.path.join('.'),
    message: detail.message,
  }));
}

// Determine the amount the plan must reconcile against: the student's remaining
// balance when available, otherwise the fee amount.
function getExpectedPlanTotal(student) {
  const candidates = [student.remainingBalance, student.feeAmount];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = money.toDecimal(candidate);
    if (value.isFinite()) return value;
  }
  return null;
}

async function createPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const { error, value } = createPaymentPlanSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        error: 'Invalid payment plan',
        code: 'VALIDATION_ERROR',
        details: formatValidationErrors(error),
      });
    }

    const { installments, allowPartialPlan } = value;

    const student = await Student.findOne({ schoolId, studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    const existingPlan = await PaymentPlan.findOne({
      schoolId,
      studentId,
      deletedAt: null,
      status: 'active',
    });
    if (existingPlan) {
      return res.status(409).json({
        error: 'An active payment plan already exists for this student',
        code: 'PLAN_ALREADY_EXISTS',
        planId: existingPlan._id,
      });
    }

    const totalAmount = installments.reduce(
      (sum, inst) => sum.plus(money.toDecimal(inst.amount)),
      money.toDecimal(0)
    );

    const expectedTotal = getExpectedPlanTotal(student);
    if (!allowPartialPlan && expectedTotal && !totalAmount.equals(expectedTotal)) {
      return res.status(400).json({
        error: 'Payment plan total does not reconcile with the student fee',
        code: 'VALIDATION_ERROR',
        details: [
          {
            field: 'installments',
            message: `Installments total ${totalAmount.toString()} does not match the expected amount ${expectedTotal.toString()}`,
          },
        ],
      });
    }

    const plan = await PaymentPlan.create({
      schoolId,
      studentId,
      totalAmount: totalAmount.toNumber(),
      installments: installments.map(inst => ({
        amount: money.toDecimal(inst.amount).toNumber(),
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
        details: { totalAmount: totalAmount.toNumber(), installmentCount: installments.length },
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
