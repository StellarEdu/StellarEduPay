'use strict';

/**
 * Migration 035: add per-operation payment identity.
 *
 * Issue #1558: a single Stellar transaction can contain up to 100 payment
 * operations. Payment identity must therefore be (txHash, opIndex) instead of
 * txHash alone, otherwise only the first operation is credited and the global
 * unique txHash index rejects the remaining rows with E11000.
 *
 * This migration:
 *   1. Backfills opIndex = 0 on every existing payment (they were all created
 *      from the first matching operation).
 *   2. Drops the legacy global unique index on txHash.
 *   3. Creates the new unique index on (txHash, opIndex).
 *
 * The per-school { schoolId, txHash } unique index is intentionally left in
 * place; it is scoped per school and does not block multi-op transactions.
 */

module.exports = {
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
  },
};
