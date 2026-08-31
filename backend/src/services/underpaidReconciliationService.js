'use strict';

/**
 * Underpaid Payment Reconciliation Service (Issue #1039)
 *
 * Handles reconciliation of partial/underpaid payments through:
 * - Automatic partial credit tracking for underpaid transactions
 * - Refund mechanism for payments that need to be returned
 * - Documentation and audit trail of all reconciliation actions
 *
 * Issue #1379: a student on a payment plan pays in installments, so every
 * installment is a partial payment against the total fee by design. Comparing
 * such a payment against the total fee amount flags it as underpaid and pulls
 * it into the credit/refund workflow, which then refunds money the parent
 * meant to pay. Where an active plan exists the benchmark is the installment
 * amount, not the total fee — see docs/payment-plans-underpaid-reconciliation.md.
 */

const mongoose = require('mongoose');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentPlan = require('../models/paymentPlanModel');
const logger = require('../utils/logger');
const lock = require('./distributedLock');
const { logAudit } = require('./auditService');
const { compareMoney } = require('../utils/money');
const refundService = require('./refundService');

// Shares the same TTL convention as the other callers of the per-student
// balance lock (paymentController.verifyPayment, stellarService.syncPaymentsForSchool).
const STUDENT_BALANCE_LOCK_TTL_MS = parseInt(process.env.STUDENT_BALANCE_LOCK_TTL_MS || '15000', 10);

/**
 * Fetch the student's active payment plan, if any.
 * @param {string} schoolId
 * @param {string} studentId
 * @returns {Promise<object|null>} the active plan, or null when the student pays in full
 */
async function getActivePaymentPlan(schoolId, studentId) {
  return PaymentPlan.findOne({
    schoolId,
    studentId,
    status: 'active',
    deletedAt: null,
  });
}

/**
 * The amount a single payment is expected to cover under a plan: the next
 * unpaid installment. Once every installment is settled the last one is used,
 * so a trailing payment is still measured against an installment rather than
 * against the whole fee.
 * @param {object} plan
 * @returns {number|null} expected installment amount, or null for an empty plan
 */
function expectedInstallmentAmount(plan) {
  const installments = plan?.installments || [];
  if (installments.length === 0) return null;
  const next = installments.find((inst) => !inst.paid);
  return (next || installments[installments.length - 1]).amount;
}

/**
 * Decide whether a payment is genuinely underpaid, or an intentional
 * installment against an active payment plan.
 *
 * A plan holder's payment is only short if it falls below the installment it
 * is paying — measuring it against the total fee would flag every installment
 * they ever make (#1379).
 *
 * @param {object} payment - Payment document (needs schoolId, studentId, amount)
 * @returns {Promise<{underpaid: boolean, basis: 'installment'|'fee', expectedAmount: number|null}>}
 */
async function evaluateUnderpayment(payment) {
  const plan = await getActivePaymentPlan(payment.schoolId, payment.studentId);
  const expectedAmount = plan ? expectedInstallmentAmount(plan) : null;

  if (expectedAmount === null) {
    // No plan (or an empty one): the existing fee-based classification stands.
    return {
      underpaid: true,
      basis: 'fee',
      expectedAmount: null,
    };
  }

  return {
    underpaid: compareMoney(payment.amount, expectedAmount) < 0,
    basis: 'installment',
    expectedAmount,
  };
}

/**
 * Apply partial credit to an underpaid payment
 * @param {string} paymentId - Payment document ID or txHash
 * @param {number} creditAmount - Amount to credit toward student balance
 * @param {string} creditAppliedBy - User/admin applying the credit
 * @param {string} schoolId - School ID for tenant scope
 * @returns {Promise<object>} Updated payment document
 */
async function applyPartialCredit(paymentId, creditAmount, creditAppliedBy, schoolId) {
  if (!creditAmount || creditAmount <= 0) {
    throw new Error('creditAmount must be a positive number');
  }

  // Find payment by ID or txHash.
  // Guard with isValid() first: passing a non-ObjectId string (e.g. a 64-char
  // Stellar txHash) to findById throws a CastError synchronously, bypassing
  // the intended txHash fallback entirely.
  let payment = mongoose.Types.ObjectId.isValid(paymentId)
    ? await Payment.findById(paymentId)
    : null;
  if (!payment) {
    payment = await Payment.findOne({ txHash: paymentId, schoolId });
  }

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  // Validate that this is an underpaid payment
  if (payment.feeValidationStatus !== 'partial' && payment.feeValidationStatus !== 'underpaid') {
    throw new Error(
      `Payment ${paymentId} is not underpaid (status: ${payment.feeValidationStatus}). ` +
      'Partial credit can only be applied to underpaid transactions.'
    );
  }

  // #1379: an installment that meets its scheduled amount is not underpaid,
  // however it compares against the total fee. Crediting or refunding it would
  // act on money the parent deliberately paid.
  const assessment = await evaluateUnderpayment(payment);
  if (!assessment.underpaid) {
    throw new Error(
      `Payment ${paymentId} is an installment against an active payment plan ` +
      `(expected ${assessment.expectedAmount}, paid ${payment.amount}) and is not underpaid. ` +
      'Underpaid reconciliation does not apply to scheduled installments.'
    );
  }

  // Guard the read-modify-write of the student's balance with the same
  // per-student distributed lock used by verifyPayment/syncPaymentsForSchool
  // (#1201), so a concurrent payment confirmation for this student can't
  // race this read-modify-write and silently lose one of the two updates.
  const studentLockKey = lock.studentBalanceLockKey(payment.schoolId, payment.studentId);
  const studentLockInfo = await lock.acquire(studentLockKey, STUDENT_BALANCE_LOCK_TTL_MS);
  if (!studentLockInfo) {
    throw new Error(
      `Could not acquire balance lock for student ${payment.studentId} — another update is in progress. Please retry.`
    );
  }
  const { token: studentLockToken } = studentLockInfo;

  let now;
  try {
    // Re-read the student's balance now that the lock is held, so the shortfall
    // check and the write below are both based on up-to-date data.
    const student = await Student.findOne({
      schoolId: payment.schoolId,
      studentId: payment.studentId,
    });

    if (!student) {
      throw new Error(
        `Student ${payment.studentId} not found in school ${payment.schoolId}`
      );
    }

    const shortfall = Math.max(0, student.feeAmount - (student.totalPaid || 0));
    if (creditAmount > shortfall) {
      throw new Error(
        `Credit amount (${creditAmount}) exceeds shortfall (${shortfall}). ` +
        'Partial credit cannot exceed the remaining fee balance.'
      );
    }

    now = new Date();

    // Update payment with credit information
    payment.underpaidReconciliation.status = 'partial_credited';
    payment.underpaidReconciliation.appliedCredit = creditAmount;
    payment.underpaidReconciliation.creditAppliedAt = now;
    payment.underpaidReconciliation.creditAppliedBy = creditAppliedBy;
    await payment.save();

    // Update student's cumulative balance.
    // creditAdjustments is incremented atomically so the consistency and
    // reconciliation jobs can add it to the raw payment sum and never treat
    // this admin-applied credit as drift.
    const newTotalPaid = (student.totalPaid || 0) + creditAmount;
    const newRemainingBalance = Math.max(0, student.feeAmount - newTotalPaid);
    await Student.findOneAndUpdate(
      { schoolId: payment.schoolId, studentId: payment.studentId },
      {
        $inc: { creditAdjustments: parseFloat(creditAmount.toFixed(7)) },
        $set: {
          totalPaid: parseFloat(newTotalPaid.toFixed(7)),
          remainingBalance: parseFloat(newRemainingBalance.toFixed(7)),
          feePaid: newTotalPaid >= student.feeAmount,
        },
      },
      { new: true }
    );

    // Audit log: record the manual credit so there is an immutable trail of
    // every admin-applied adjustment that the consistency job must respect.
    await logAudit({
      schoolId: payment.schoolId,
      action: 'PARTIAL_CREDIT_APPLIED',
      performedBy: creditAppliedBy,
      targetId: payment.studentId,
      targetType: 'Student',
      details: {
        paymentId: payment._id.toString(),
        txHash: payment.txHash,
        creditAmount,
        newTotalPaid: parseFloat(newTotalPaid.toFixed(7)),
        newRemainingBalance: parseFloat(newRemainingBalance.toFixed(7)),
      },
    });
  } finally {
    await lock.release(studentLockKey, studentLockToken);
  }

  logger.info('[UnderpaidReconciliation] Partial credit applied', {
    paymentId: payment._id,
    txHash: payment.txHash,
    schoolId: payment.schoolId,
    studentId: payment.studentId,
    creditAmount,
    creditAppliedBy,
    timestamp: now.toISOString(),
  });

  return payment;
}

/**
 * Initiate refund for an underpaid payment using the safe, centralized refund service.
 * Issue #1472: Consolidate refund mechanisms to use the approved refundService workflow.
 *
 * This function delegates to refundService.initiateRefund to ensure:
 * - Distributed lock prevents concurrent refunds of the same payment
 * - Maker-checker approval workflow enforces two-operator review
 * - Duplicate refund guards prevent multiple refunds for one payment
 *
 * @param {string} paymentId - Payment document ID or txHash
 * @param {string} refundInitiatedBy - User/admin initiating the refund
 * @param {string} schoolId - School ID for tenant scope
 * @param {string} refundNote - Optional note about the refund reason
 * @returns {Promise<object>} Refund document created via refundService
 * @throws Error if payment not found, not underpaid, or refund workflow fails
 */
async function initiateRefund(paymentId, refundInitiatedBy, schoolId, refundNote = null) {
  // Find payment by ID or txHash (same isValid() guard as applyPartialCredit)
  let payment = mongoose.Types.ObjectId.isValid(paymentId)
    ? await Payment.findById(paymentId)
    : null;
  if (!payment) {
    payment = await Payment.findOne({ txHash: paymentId, schoolId });
  }

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  // Validate that this is an underpaid payment
  if (payment.feeValidationStatus !== 'partial' && payment.feeValidationStatus !== 'underpaid') {
    throw new Error(
      `Payment ${paymentId} is not underpaid (status: ${payment.feeValidationStatus}). ` +
      'Refunds can only be initiated for underpaid transactions.'
    );
  }

  // #1379: an installment that meets its scheduled amount is not underpaid,
  // however it compares against the total fee. Crediting or refunding it would
  // act on money the parent deliberately paid.
  const assessment = await evaluateUnderpayment(payment);
  if (!assessment.underpaid) {
    throw new Error(
      `Payment ${paymentId} is an installment against an active payment plan ` +
      `(expected ${assessment.expectedAmount}, paid ${payment.amount}) and is not underpaid. ` +
      'Underpaid reconciliation does not apply to scheduled installments.'
    );
  }

  // Delegate to the safe refundService for the actual refund initiation workflow.
  // This ensures:
  //   - Distributed lock prevents concurrent refund attempts
  //   - Maker-checker approval (two-operator review) is enforced
  //   - Duplicate refunds are prevented by ACTIVE_REFUND_STATUSES guard
  //   - Refund document is properly stored with audit trail
  const reason = refundNote || 'Underpaid payment reconciliation';
  const refund = await refundService.initiateRefund(
    schoolId,
    payment.txHash,
    payment.studentId,
    payment.amount,
    reason,
    refundInitiatedBy
  );

  logger.info('[UnderpaidReconciliation] Refund initiated via refundService', {
    paymentId: payment._id,
    txHash: payment.txHash,
    schoolId: payment.schoolId,
    studentId: payment.studentId,
    refundId: refund._id,
    amount: payment.amount,
    refundInitiatedBy,
    reason,
  });

  return refund;
}

/**
 * Complete refund for an underpaid payment
 * Called when refund transaction is confirmed on-chain
 * @param {string} paymentId - Payment document ID or txHash
 * @param {string} refundTxHash - Stellar transaction hash of the refund
 * @param {string} schoolId - School ID for tenant scope
 * @returns {Promise<object>} Updated payment document
 */
async function completeRefund(paymentId, refundTxHash, schoolId) {
  if (!refundTxHash) {
    throw new Error('refundTxHash is required to complete refund');
  }

  // Find payment by ID or txHash, always scoped to schoolId so that a
  // caller cannot act on a payment belonging to a different tenant —
  // matching the isolation pattern used by applyPartialCredit and
  // initiateRefund in this file.
  let payment = mongoose.Types.ObjectId.isValid(paymentId)
    ? await Payment.findOne({ _id: paymentId, schoolId })
    : null;
  if (!payment) {
    payment = await Payment.findOne({ txHash: paymentId, schoolId });
  }

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  const now = new Date();

  // Update refund completion status
  payment.underpaidReconciliation.status = 'refund_completed';
  payment.underpaidReconciliation.refundTxHash = refundTxHash;
  payment.underpaidReconciliation.refundCompletedAt = now;
  await payment.save();

  logger.info('[UnderpaidReconciliation] Refund completed', {
    paymentId: payment._id,
    originalTxHash: payment.txHash,
    refundTxHash,
    schoolId: payment.schoolId,
    studentId: payment.studentId,
    amount: payment.amount,
    timestamp: now.toISOString(),
  });

  return payment;
}

/**
 * Get underpaid payments pending reconciliation for a school
 * @param {string} schoolId - School ID
 * @param {object} options - Query options
 * @returns {Promise<array>} Array of pending underpaid payments
 */
async function getPendingUnderpaidPayments(schoolId, options = {}) {
  const {
    studentId = null,
    limit = 50,
    skip = 0,
  } = options;

  const query = {
    schoolId,
    feeValidationStatus: { $in: ['partial', 'underpaid'] },
    status: 'SUCCESS',
    deletedAt: null,
    'underpaidReconciliation.status': 'pending',
  };

  if (studentId) {
    query.studentId = studentId;
  }

  const payments = await Payment.find(query)
    .sort({ confirmedAt: -1 })
    .skip(skip)
    .limit(limit);

  // #1379: drop payments that only look short because they were measured
  // against the total fee. A plan holder's installment that meets its
  // scheduled amount must never reach the credit/refund workflow.
  const assessments = await Promise.all(payments.map(evaluateUnderpayment));
  return payments.filter((_, i) => assessments[i].underpaid);
}

/**
 * Get reconciliation summary for underpaid payments
 * @param {string} schoolId - School ID
 * @returns {Promise<object>} Summary statistics
 */
async function getUnderpaidReconciliationSummary(schoolId) {
  const stats = await Payment.aggregate([
    {
      $match: {
        schoolId,
        feeValidationStatus: { $in: ['partial', 'underpaid'] },
        status: 'SUCCESS',
        deletedAt: null,
      },
    },
    {
      $facet: {
        byReconciliationStatus: [
          {
            $group: {
              _id: '$underpaidReconciliation.status',
              count: { $sum: 1 },
              totalAmount: { $sum: '$amount' },
            },
          },
        ],
        totalStats: [
          {
            $group: {
              _id: null,
              totalUnderpaid: { $sum: 1 },
              totalAmount: { $sum: '$amount' },
              avgShortfall: {
                $avg: {
                  $cond: [
                    { $eq: ['$feeValidationStatus', 'partial'] },
                    { $subtract: ['$feeAmount', '$amount'] },
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);

  return {
    byReconciliationStatus: stats[0]?.byReconciliationStatus || [],
    totalStats: stats[0]?.totalStats?.[0] || {},
  };
}

module.exports = {
  getActivePaymentPlan,
  expectedInstallmentAmount,
  evaluateUnderpayment,
  applyPartialCredit,
  initiateRefund,
  completeRefund,
  getPendingUnderpaidPayments,
  getUnderpaidReconciliationSummary,
};
