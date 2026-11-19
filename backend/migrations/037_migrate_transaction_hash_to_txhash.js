'use strict';

/**
 * Migration 037: migrate payments.transactionHash -> payments.txHash
 *
 * - Backfills `txHash` from the legacy `transactionHash` field for documents
 *   that are missing `txHash`.
 * - Removes the legacy `transactionHash` field from all payment documents.
 * - Drops any legacy `transactionHash` index.
 *
 * The `down()` is safe to re-run and does not reintroduce a global unique
 * `txHash` constraint.
 */

module.exports = {
  async up(db) {
    const payments = db.collection('payments');

    // 1. Backfill txHash from transactionHash where txHash is missing/empty.
    //    Use a bulk update so we only touch documents that need it.
    const cursor = payments.find(
      {
        $and: [
          { transactionHash: { $exists: true, $nin: [null, ''] } },
          {
            $or: [
              { txHash: { $exists: false } },
              { txHash: null },
              { txHash: '' },
            ],
          },
        ],
      },
      { projection: { _id: 1, transactionHash: 1 } }
    );

    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const ops = batch.map(({ _id, transactionHash }) => ({
        updateOne: {
          filter: { _id },
          update: { $set: { txHash: transactionHash } },
        },
      }));
      await payments.bulkWrite(ops, { ordered: false });
      batch = [];
    };

    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= 500) {
        await flush();
      }
    }
    await flush();

    // 2. Remove the legacy transactionHash field from all documents.
    await payments.updateMany(
      { transactionHash: { $exists: true } },
      { $unset: { transactionHash: '' } }
    );

    // 3. Drop any legacy transactionHash index (safe if it does not exist).
    const indexes = await payments.indexes().catch(() => []);
    for (const idx of indexes) {
      if (!idx || !idx.key) continue;
      if (Object.prototype.hasOwnProperty.call(idx.key, 'transactionHash')) {
        try {
          await payments.dropIndex(idx.name);
        } catch (err) {
          // Ignore "index not found" style errors so the migration is re-runnable.
          if (err && err.codeName !== 'IndexNotFound' && err.code !== 27) {
            throw err;
          }
        }
      }
    }
  },

  async down(db) {
    const payments = db.collection('payments');

    // 1. Backfill transactionHash from txHash where transactionHash is missing.
    //    This is idempotent: documents that already have transactionHash are
    //    left untouched.
    const cursor = payments.find(
      {
        $and: [
          { txHash: { $exists: true, $nin: [null, ''] } },
          {
            $or: [
              { transactionHash: { $exists: false } },
              { transactionHash: null },
              { transactionHash: '' },
            ],
          },
        ],
      },
      { projection: { _id: 1, txHash: 1 } }
    );

    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const ops = batch.map(({ _id, txHash }) => ({
        updateOne: {
          filter: { _id },
          update: { $set: { transactionHash: txHash } },
        },
      }));
      await payments.bulkWrite(ops, { ordered: false });
      batch = [];
    };

    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= 500) {
        await flush();
      }
    }
    await flush();

    // 2. Do NOT recreate any legacy transactionHash index, and do NOT
    //    reintroduce a global unique txHash constraint. The current schema
    //    relies on the compound { schoolId, txHash, opIndex } uniqueness
    //    instead, which is managed elsewhere.
  },
};