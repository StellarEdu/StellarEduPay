'use strict';

/**
 * Shared utility for updating student balance fields after a successful payment.
 *
 * Used by verifyPayment, submitTransaction, and syncPaymentsForSchool to ensure
 * consistent balance computation across all payment recording paths.
 * Issue #1034: Consolidates three divergent implementations into one.
 * Issue #1751: This module is the single source of truth for the canonical
 * paid/remaining/feePaid rule. Every pipeline (poller, manual sync, finalizer,
 * verify, reminders) must record the payment and then call
 * `updateStudentBalance` (or read via `computeStudentBalance`) instead of
 * running its own inline aggregation.
 *
 * Canonical rule (see docs/payment-plans-underpaid-reconciliation.md):
 *   Paid = Σ amount of payments where status === 'SUCCESS'
 *          and not suspicious and not deleted
 *          + creditAdjustments
 *          − completed refunds
 */

const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const AcademicPeriod = require('../models/academicPeriodModel');
const StudentPeriodFee = require('../models/studentPeriodFeeModel');
const { toMoney, decimalFromMongo, classifyFeePayment } = require('./money');

/**
 * Canonical feeValidationStatus vocabulary (Issue #1766).
 *
 * `classifyFeePayment` is the single source of truth for classifying a
 * cumulative total against the fee. This helper maps its result onto the
 * `Payment.feeValidationStatus` enum so every writer (verify, sync, poller)
 * records the same value for the same economic event:
 *   - 'valid'      cumulative total equals the fee
 *   - 'partial'    cumulative total below the fee (accepted installment)
 *   - 'overpaid'   cumulative total above the fee
 *   - 'unknown'    fee amount not available / not classifiable
 *
 * @param {Object} classification - Result of classifyFeePayment
 * @returns {'valid'|'partial'|'overpaid'|'unknown'}
 */
function feeValidationStatusFromClassification(classification) {
  if (!classification || classification.feeAmount === null || classification.feeAmount === undefined) {
    return 'unknown';
  }
  if (classification.feePaid) {
    return 'valid';
  }
  if (classification.remainingBalance && classification.remainingBalance.greaterThan(0)) {
    return 'partial';
  }
  return 'overpaid';
}

/**
 * Canonical `$match` filter for payments that count toward a student's paid
 * total (Issue #1751). FAILED, PENDING, REFUNDED, DISPUTED and suspicious
 * payments are excluded so every pipeline agrees on what "paid" means.
 *
 * @param {string} schoolId
 * @param {string} studentId
 * @param {string} [feeCategory] - Optional fee category to scope the sum
 * @returns {Object} MongoDB match stage
 */
function canonicalPaidMatch(schoolId, studentId, feeCategory) {
  const match = {
    schoolId,
    studentId,
    deletedAt: null,
    status: 'SUCCESS',
    isSuspicious: false,
  };
  if (feeCategory !== undefined) {
    match.feeCategory = feeCategory;
  }
  return match;
}

/**
 * Sum the canonical paid amount for a student (or a single fee category) in
 * exact Decimal128 space. This is the shared reader used by reminders and any
 * other consumer that must not recompute with a divergent filter.
 *
 * @param {string} schoolId
 * @param {string} studentId
 * @param {Object} [options]
 * @param {Object} [options.session]
 * @param {string} [options.feeCategory]
 * @returns {Promise<Object>} Decimal total of qualifying payments
 */
async function sumCanonicalPayments(schoolId, studentId, options = {}) {
  const { session = null, feeCategory } = options;
  const agg = await Payment.aggregate([
    { $match: canonicalPaidMatch(schoolId, studentId, feeCategory) },
    { $group: { _id: null, total: { $sum: { $toDecimal: '$amount' } } } },
  ]).session(session);
  return agg.length ? decimalFromMongo(agg[0].total) : toMoney(0);
}

/**
 * Compute the canonical balance fields for a student without persisting them.
 * Used by reminders and other read-only consumers so they never diverge from
 * the stored balance written by `updateStudentBalance`.
 *
 * @param {string} schoolId
 * @param {string} studentId
 * @param {Object} [options]
 * @param {Object} [options.session]
 * @returns {Promise<Object|null>} { totalPaid, remainingBalance, feePaid } or null
 */
async function computeStudentBalance(schoolId, studentId, options = {}) {
  const { session = null } = options;
  const student = await Student.findOne({ schoolId, studentId }).session(session);
  if (!student) {
    return null;
  }

  const paymentTotal = await sumCanonicalPayments(schoolId, studentId, { session });
  const creditAdjustments = toMoney(student.creditAdjustments || 0);
  const cumulativeTotal = toMoney(paymentTotal.plus(creditAdjustments));
  const classification = classifyFeePayment(cumulativeTotal, student.feeAmount);

  return {
    totalPaid: classification.cumulativeTotal,
    remainingBalance: classification.remainingBalance,
    feePaid: classification.feePaid,
  };
}

/**
 * Update a student's balance fields (totalPaid, remainingBalance, feePaid) after
 * a successful payment is recorded. This is the ONLY writer of those fields
 * (Issue #1751).
 *
 * @param {string} schoolId - School ID
 * @param {string} studentId - Student ID
 * @param {Object} options - Optional configuration
 * @param {Object} options.session - Mongoose session for transaction (if applicable)
 * @param {boolean} options.includeFeeCategoryBreakdown - Whether to update individual fee categories
 * @returns {Promise<Object>} - Updated student object or null if not found
 */
async function updateStudentBalance(schoolId, studentId, options = {}) {
  const { session = null, includeFeeCategoryBreakdown = true } = options;

  // Fetch the current student record
  const student = await Student.findOne({ schoolId, studentId }).session(session);
  if (!student) {
    return null;
  }

  // Canonical balance formula (fix #1751):
  //   Paid = Σ amount  where  status === 'SUCCESS'
  //                           AND isSuspicious === false
  //                           AND deletedAt  === null     (not soft-deleted)
  //                           AND status !== 'REFUNDED'   (excluded via explicit allowlist above)
  //
  // "status === 'SUCCESS'" already excludes PENDING, FAILED, SUBMITTED, and
  // REFUNDED in one predicate — REFUNDED payments can only reach that value
  // if manually set, so we make the exclusion explicit and unambiguous here.
  //
  // Summed via $toDecimal (#1123 money-representation fix) so MongoDB adds
  // the amounts in exact Decimal128 space instead of accumulating float
  // error across every installment for the life of the account.
  const paymentTotal = await sumCanonicalPayments(schoolId, studentId, { session });

  // Include creditAdjustments in the cumulative total (Issue #1473).
  // creditAdjustments represent manual partial-credit overrides applied by admins
  // and must be included in the expected total so they are never silently reverted
  // by subsequent reconciliation or balance update runs.
  const creditAdjustments = toMoney(student.creditAdjustments || 0);
  const cumulativeTotal = toMoney(paymentTotal.plus(creditAdjustments));
  const classification = classifyFeePayment(cumulativeTotal, student.feeAmount);

  // Compute top-level student balance
  const updateData = {
    totalPaid: classification.cumulativeTotal,
    remainingBalance: classification.remainingBalance,
    feePaid: classification.feePaid,
  };

  // If student has per-category fees, update those balances too
  if (includeFeeCategoryBreakdown && student.fees && student.fees.length > 0) {
    const feesUpdated = [...student.fees];

    for (let i = 0; i < feesUpdated.length; i++) {
      const category = feesUpdated[i].category;

      const categoryTotalDecimal = await sumCanonicalPayments(schoolId, studentId, {
        session,
        feeCategory: category,
      });
      const categoryClassification = classifyFeePayment(categoryTotalDecimal, feesUpdated[i].amount);

      feesUpdated[i].totalPaid = categoryClassification.cumulativeTotal;
      feesUpdated[i].remainingBalance = categoryClassification.remainingBalance;
      feesUpdated[i].paid = categoryClassification.feePaid;
    }

    updateData.fees = feesUpdated;
  }

  // Persist the update
  const updatedStudent = await Student.findOneAndUpdate(
    { schoolId, studentId },
    updateData,
    { new: true, session }
  );

  await syncCurrentPeriodFee(schoolId, studentId, session);

  return updatedStudent;
}

/**
 * Keep the current academic period's StudentPeriodFee in step with payments (#1785).
 *
 * Payments carry no periodId, so a payment is attributed to the current period
 * when it was made on or after the period's start. Closed periods are no longer
 * current, so their totals stay frozen after a rollover.
 */
async function syncCurrentPeriodFee(schoolId, studentId, session) {
  const period = await AcademicPeriod.findOne({ schoolId, isCurrent: true }).session(session).lean();
  if (!period) return;

  const periodFee = await StudentPeriodFee.findOne({ schoolId, studentId, periodId: period._id }).session(session);
  if (!periodFee) return;

  const paidAgg = await Payment.aggregate([
    {
      $match: {
        schoolId,
        studentId,
        deletedAt: null,
        status: 'SUCCESS',
        isSuspicious: false,
        createdAt: { $gte: period.startsAt },
      },
    },
    { $group: { _id: null, total: { $sum: { $toDecimal: '$amount' } } } },
  ]).session(session);

  const paymentTotal = paidAgg.length ? decimalFromMongo(paidAgg[0].total) : toMoney(0);
  const cumulativeTotal = toMoney(paymentTotal.plus(periodFee.creditAdjustments || 0));
  const totalDue = (periodFee.feeAmount || 0) + (periodFee.carriedArrears || 0);
  const classification = classifyFeePayment(cumulativeTotal, totalDue);

  await StudentPeriodFee.updateOne(
    { _id: periodFee._id },
    {
      $set: {
        totalPaid: classification.cumulativeTotal,
        remainingBalance: classification.remainingBalance,
        feePaid: classification.feePaid,
      },
    },
    { session }
  );
}

module.exports = {
  updateStudentBalance,
  computeStudentBalance,
  sumCanonicalPayments,
  canonicalPaidMatch,
  feeValidationStatusFromClassification,
};
