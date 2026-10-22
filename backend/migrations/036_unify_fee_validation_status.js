'use strict';

/**
 * Migration 036: Unify Payment.feeValidationStatus vocabulary.
 *
 * Historically two writers disagreed on the value used when the cumulative
 * amount paid is below the fee:
 *   - utils/money.classifyFeePayment and stellarService.syncPaymentsForSchool
 *     wrote 'partial'
 *   - transactionPollingService.processTransaction wrote 'underpaid'
 *
 * The chosen vocabulary (see docs/payment-plans-underpaid-reconciliation.md):
 *   - 'partial'   -> cumulative total below the fee, accepted as an installment
 *   - 'underpaid' -> payment below the expected installment when a plan exists
 *   - 'valid', 'overpaid', 'unknown' keep their existing meaning
 *
 * This migration normalizes historical rows:
 *   - 'underpaid' rows that do NOT correspond to a missed installment on an
 *     active plan are reclassified as 'partial'
 *   - any value outside the canonical enum is set to 'unknown'
 *
 * The migration is idempotent: re-running it produces no further changes.
 */

const CANONICAL_STATUSES = ['valid', 'underpaid', 'overpaid', 'partial', 'unknown'];

module.exports = {
  async up(db) {
    const payments = db.collection('payments');
    const plans = db.collection('paymentplans');

    const log = {
      scanned: 0,
      underpaidToPartial: 0,
      unknownNormalized: 0,
      underpaidKept: 0,
    };

    // 1. Normalize any non-canonical values to 'unknown'.
    const unknownResult = await payments.updateMany(
      { feeValidationStatus: { $nin: CANONICAL_STATUSES } },
      { $set: { feeValidationStatus: 'unknown' } }
    );
    log.unknownNormalized = unknownResult.modifiedCount || 0;

    // Also catch rows where the field is missing entirely.
    const missingResult = await payments.updateMany(
      { feeValidationStatus: { $exists: false } },
      { $set: { feeValidationStatus: 'unknown' } }
    );
    log.unknownNormalized += missingResult.modifiedCount || 0;

    // 2. Reclassify 'underpaid' rows that are not tied to a missed installment
    //    on an active plan. We collect the set of studentIds that have an
    //    active plan with a missed installment; 'underpaid' rows for students
    //    outside that set are cumulative-below-fee payments and become 'partial'.
    const underpaidCursor = payments.find(
      { feeValidationStatus: 'underpaid' },
      { projection: { _id: 1, studentId: 1, schoolId: 1 } }
    );

    const toPartialIds = [];
    const underpaidIds = [];

    while (await underpaidCursor.hasNext()) {
      const payment = await underpaidCursor.next();
      log.scanned += 1;

      const hasMissedInstallment = await hasMissedInstallmentOnActivePlan(
        plans,
        payment
      );

      if (hasMissedInstallment) {
        underpaidIds.push(payment._id);
        log.underpaidKept += 1;
      } else {
        toPartialIds.push(payment._id);
      }
    }

    // 3. Apply the reclassification in batches to keep memory bounded.
    const BATCH_SIZE = 500;
    for (let i = 0; i < toPartialIds.length; i += BATCH_SIZE) {
      const batch = toPartialIds.slice(i, i + BATCH_SIZE);
      const result = await payments.updateMany(
        { _id: { $in: batch }, feeValidationStatus: 'underpaid' },
        { $set: { feeValidationStatus: 'partial' } }
      );
      log.underpaidToPartial += result.modifiedCount || 0;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[migration 036] feeValidationStatus normalization complete: ` +
        `scanned=${log.scanned} ` +
        `underpaid->partial=${log.underpaidToPartial} ` +
        `underpaid kept (missed installment)=${log.underpaidKept} ` +
        `normalized to unknown=${log.unknownNormalized}`
    );

    return log;
  },

  async down(db) {
    // Reverting is intentionally a no-op: the previous state mixed two
    // vocabularies and cannot be reconstructed reliably. The forward
    // migration is idempotent, so re-running it is safe.
    // eslint-disable-next-line no-console
    console.log(
      '[migration 036] down() is a no-op; feeValidationStatus vocabulary is unified.'
    );
  },
};

/**
 * Determine whether a payment corresponds to a missed installment on an
 * active payment plan. A payment is considered "underpaid" (installment
 * semantics) when the student has an active plan and the payment's amount is
 * below the expected installment amount for that plan.
 *
 * @param {import('mongodb').Collection} plans
 * @param {{ studentId?: any, schoolId?: any, amount?: number }} payment
 * @returns {Promise<boolean>}
 */
async function hasMissedInstallmentOnActivePlan(plans, payment) {
  if (!payment || payment.studentId == null) {
    return false;
  }

  const query = {
    studentId: payment.studentId,
    status: 'active',
  };
  if (payment.schoolId != null) {
    query.schoolId = payment.schoolId;
  }

  const plan = await plans.findOne(query, {
    projection: { installmentAmount: 1, amount: 1, installments: 1 },
  });

  if (!plan) {
    return false;
  }

  const expectedInstallment = resolveExpectedInstallment(plan);
  if (expectedInstallment == null) {
    return false;
  }

  const paid = typeof payment.amount === 'number' ? payment.amount : 0;
  return paid < expectedInstallment;
}

/**
 * Resolve the expected installment amount for a plan, tolerating the
 * different shapes plans have been stored in over time.
 *
 * @param {{ installmentAmount?: number, amount?: number, installments?: number }} plan
 * @returns {number|null}
 */
function resolveExpectedInstallment(plan) {
  if (typeof plan.installmentAmount === 'number' && plan.installmentAmount > 0) {
    return plan.installmentAmount;
  }
  if (
    typeof plan.amount === 'number' &&
    typeof plan.installments === 'number' &&
    plan.installments > 0
  ) {
    return plan.amount / plan.installments;
  }
  return null;
}