'use strict';

/**
 * paymentPlanAllocationService.js  (#1984)
 *
 * Applies confirmed on-chain payments to a student's active payment plan and
 * reverses those allocations when a refund is confirmed.
 *
 * Idempotency: every allocation is keyed on (txHash, opIndex). A payment that
 * was already applied to the plan is skipped, so at-least-once delivery of the
 * payment.saved / refund.status_changed events cannot double-count money.
 */

const PaymentPlan = require('../models/paymentPlanModel');
const logger = require('../utils/logger').child('PaymentPlanAllocation');

const EPSILON = 1e-7;

function round7(value) {
  return Math.round(value * 1e7) / 1e7;
}

function allocationKey(txHash, opIndex) {
  return `${txHash}:${opIndex == null ? 0 : opIndex}`;
}

function isConfirmedNonSuspicious(payment) {
  if (!payment) return false;
  if (payment.status !== 'SUCCESS' && payment.status !== 'confirmed') return false;
  if (payment.suspicious || payment.isSuspicious) return false;
  if (payment.feeValidationStatus === 'suspicious') return false;
  return true;
}

/**
 * Allocate a confirmed payment to the oldest unpaid installments (FIFO).
 * Returns the updated plan, or null when there is nothing to do.
 */
async function allocatePaymentToPlan(schoolId, studentId, amount, txHash, opIndex = 0) {
  if (!schoolId || !studentId || !txHash) return null;
  const value = round7(Number(amount) || 0);
  if (value <= 0) return null;

  const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null, status: 'active' });
  if (!plan) return null;

  const key = allocationKey(txHash, opIndex);
  const alreadyApplied = (plan.installments || []).some((inst) =>
    (inst.paymentTxHashes || []).includes(key)
  );
  if (alreadyApplied) return plan;

  let remaining = value;
  for (const installment of plan.installments) {
    if (remaining <= EPSILON) break;
    const outstanding = round7(installment.amount - (installment.paidAmount || 0));
    if (outstanding <= EPSILON) continue;

    const applied = Math.min(remaining, outstanding);
    installment.paidAmount = round7((installment.paidAmount || 0) + applied);
    remaining = round7(remaining - applied);

    installment.paymentTxHashes = installment.paymentTxHashes || [];
    installment.paymentTxHashes.push(key);

    if (installment.paidAmount >= installment.amount - EPSILON) {
      installment.paid = true;
      installment.paidAt = installment.paidAt || new Date();
    }
  }

  if (plan.installments.every((inst) => inst.paid)) {
    plan.status = 'completed';
  }
  plan.updatedAt = new Date();
  await plan.save();
  return plan;
}

/**
 * Reverse a previously applied allocation (refund confirmed).
 * Walks installments newest-first so the most recent allocation is undone.
 */
async function reversePaymentFromPlan(schoolId, studentId, amount, txHash, opIndex = 0) {
  if (!schoolId || !studentId) return null;
  let remaining = round7(Number(amount) || 0);
  if (remaining <= 0) return null;

  const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
  if (!plan) return null;

  const key = txHash ? allocationKey(txHash, opIndex) : null;

  for (let i = plan.installments.length - 1; i >= 0 && remaining > EPSILON; i -= 1) {
    const installment = plan.installments[i];
    const paid = round7(installment.paidAmount || 0);
    if (paid <= EPSILON) continue;

    const reversed = Math.min(remaining, paid);
    installment.paidAmount = round7(paid - reversed);
    remaining = round7(remaining - reversed);

    if (key && Array.isArray(installment.paymentTxHashes)) {
      installment.paymentTxHashes = installment.paymentTxHashes.filter((h) => h !== key);
    }

    if (installment.paidAmount < installment.amount - EPSILON) {
      installment.paid = false;
      installment.paidAt = null;
    }
  }

  if (plan.status === 'completed' && plan.installments.some((inst) => !inst.paid)) {
    plan.status = 'active';
  }
  plan.updatedAt = new Date();
  await plan.save();
  return plan;
}

/** payment.saved subscriber — applies confirmed, non-suspicious payments. */
async function onPaymentSavedAllocateToPlan(payment) {
  try {
    if (!isConfirmedNonSuspicious(payment)) return;
    const txHash = payment.txHash || payment.transactionHash;
    await allocatePaymentToPlan(
      payment.schoolId,
      payment.studentId,
      payment.amount,
      txHash,
      payment.opIndex
    );
  } catch (err) {
    logger.error('Payment plan allocation failed', {
      txHash: payment && (payment.txHash || payment.transactionHash),
      error: err.message,
    });
  }
}

/** refund.status_changed subscriber — reverses allocations on confirmed refunds. */
async function onRefundConfirmedReversePlan(refundEvent) {
  try {
    if (!refundEvent || refundEvent.newStatus !== 'confirmed') return;
    await reversePaymentFromPlan(
      refundEvent.schoolId,
      refundEvent.studentId,
      refundEvent.amount,
      refundEvent.originalTxHash,
      refundEvent.opIndex
    );
  } catch (err) {
    logger.error('Payment plan reversal failed', {
      originalTxHash: refundEvent && refundEvent.originalTxHash,
      error: err.message,
    });
  }
}

module.exports = {
  allocatePaymentToPlan,
  reversePaymentFromPlan,
  onPaymentSavedAllocateToPlan,
  onRefundConfirmedReversePlan,
  isConfirmedNonSuspicious,
};
