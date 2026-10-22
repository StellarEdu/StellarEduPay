'use strict';

/**
 * Migration 035: add per-operation payment identity and clean up
 * verification-failure placeholders.
 *
 * Issue #1558: a single Stellar transaction can contain up to 100 payment
 * operations. Payment identity must therefore be (txHash, opIndex) instead of
 * txHash alone, otherwise only the first operation is credited and the global
 * unique txHash index rejects the remaining rows with E11000.
 *
 * Issue #1761: verifyPayment used to insert a permanent FAILED placeholder
 * (studentId "unknown", amount 0) into `payments` for every verification
 * failure. Those rows block re-verification, halt manual sync and pollute
 * payment lists. This migration moves them into a dedicated
 * `payment_verification_attempts` collection so they no longer interfere.
 *
 * This migration:
 *   1. Backfills opIndex = 0 on every existing payment (they were all created
 *      from the first matching operation).
 *   2. Drops the legacy global unique index on txHash.
 *   3. Creates the new unique index on (txHash, opIndex).
 *   4. Moves verification-failure placeholders out of `payments` into
 *      `payment_verification_attempts`.
 *
 * The per-school { schoolId, txHash } unique index is intentionally left in
 * place; it is scoped per school and does not block multi-op transactions.
 */

const VERSION = '035_add_payment_op_index';

const PLACEHOLDER_FILTER = {
  studentId: 'unknown',
  amount: 0,
  status: 'FAILED',
};

module.exports = {
  version: VERSION,

  async up(db) {
    const payments = db.collection('payments');

    // 1. Backfill opIndex = 0 for all pre-existing payments.
    await payments.updateMany(
      { opIndex: { $exists: false } },
      { $set: { opIndex: 0 } }
    );

    // 2. Drop the legacy global unique txHash index if it exists.
    const indexes = await payments.indexes();
    const legacy = indexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        idx.key.txHash === 1
    );
    if (legacy) {
      await payments.dropIndex(legacy.name);
    }

    // 3. Create the per-operation unique index.
    await payments.createIndex(
      { txHash: 1, opIndex: 1 },
      { unique: true, name: 'txHash_1_opIndex_1' }
    );

    // 4. Move verification-failure placeholders out of `payments`.
    const attempts = db.collection('payment_verification_attempts');

    const placeholders = await payments
      .find(PLACEHOLDER_FILTER)
      .toArray();

    if (placeholders.length > 0) {
      const now = new Date();
      const attemptDocs = placeholders.map((doc) => ({
        txHash: doc.txHash,
        schoolId: doc.schoolId,
        code: doc.rejectionCode || doc.failureCode || 'UNKNOWN',
        message: doc.failureReason || doc.message || null,
        attemptedAt: doc.createdAt || doc.updatedAt || now,
        migratedAt: now,
        source: 'migration_035',
        originalPaymentId: doc._id,
      }));

      await attempts.insertMany(attemptDocs, { ordered: false });

      await payments.deleteMany(PLACEHOLDER_FILTER);
    }

    // Support lookups by transaction and by school for audit/support.
    await attempts.createIndex(
      { txHash: 1, schoolId: 1 },
      { name: 'txHash_1_schoolId_1' }
    );
    await attempts.createIndex(
      { attemptedAt: 1 },
      { name: 'attemptedAt_1' }
    );
  },

  async down(db) {
    const payments = db.collection('payments');

    // Remove the per-operation index and restore the legacy global unique index.
    const indexes = await payments.indexes();
    const perOp = indexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        idx.key.txHash === 1 &&
        idx.key.opIndex === 1
    );
    if (perOp) {
      await payments.dropIndex(perOp.name);
    }

    await payments.createIndex(
      { txHash: 1 },
      { unique: true, sparse: true, name: 'txHash_1' }
    );

    // Restore migrated verification-failure placeholders into `payments`.
    const attempts = db.collection('payment_verification_attempts');
    const migrated = await attempts
      .find({ source: 'migration_035' })
      .toArray();

    if (migrated.length > 0) {
      const restored = migrated.map((doc) => ({
        _id: doc.originalPaymentId,
        schoolId: doc.schoolId,
        studentId: 'unknown',
        txHash: doc.txHash,
        amount: 0,
        status: 'FAILED',
        feeValidationStatus: 'unknown',
        rejectionCode: doc.code,
        failureReason: doc.message,
        createdAt: doc.attemptedAt,
        opIndex: 0,
      }));

      await payments.insertMany(restored, { ordered: false });
      await attempts.deleteMany({ source: 'migration_035' });
    }
  },
};