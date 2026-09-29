'use strict';

/**
 * Migration 032 — align payment txHash indexes with the model contract.
 *
 * The application model declares two indexes on payments:
 *   - { schoolId: 1, txHash: 1 } unique
 *   - { txHash: 1 } unique sparse
 *
 * Legacy data sometimes still has the old single-field unique txHash index
 * from before multi-school scoping. This migration removes the legacy
 * single-school uniqueness constraint, then ensures the multi-school indexes
 * are present and safe to re-run.
 *
 * Rollback:
 *   down() removes the indexes created here. It intentionally does NOT
 *   recreate the legacy global unique index because reintroducing it would
 *   violate multi-school uniqueness and could fail on real data.
 */

const VERSION = '032_fix_payment_txhash_indexes';

async function up(db) {
  const collection = db.collection('payments');

  const indexes = await collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });

  const legacyUniqueIndex = indexes.find(
    (idx) => idx.unique && idx.key && idx.key.txHash === 1 && !idx.key.schoolId
  );

  if (legacyUniqueIndex) {
    await collection.dropIndex(legacyUniqueIndex.name);
    console.log(`[Migration 032] Dropped legacy unique index: ${legacyUniqueIndex.name}`);
  } else {
    console.log('[Migration 032] Legacy unique txHash index not found; leaving as-is.');
  }

  try {
    await collection.createIndex(
      { schoolId: 1, txHash: 1 },
      { unique: true, background: true, name: 'schoolId_1_txHash_1_unique' }
    );
    console.log('[Migration 032] Created unique index on payments.{schoolId, txHash}');
  } catch (err) {
    if (err.codeName !== 'IndexOptionsConflict' && err.codeName !== 'IndexAlreadyExists') {
      throw err;
    }
    console.log('[Migration 032] Unique payments.{schoolId, txHash} index already exists.');
  }

  try {
    await collection.createIndex(
      { txHash: 1 },
      { unique: true, sparse: true, background: true, name: 'txHash_1_sparse_unique' }
    );
    console.log('[Migration 032] Created sparse unique index on payments.txHash');
  } catch (err) {
    if (err.codeName !== 'IndexOptionsConflict' && err.codeName !== 'IndexAlreadyExists') {
      throw err;
    }
    console.log('[Migration 032] Sparse unique payments.txHash index already exists.');
  }
}

async function down(db) {
  const collection = db.collection('payments');

  for (const name of ['schoolId_1_txHash_1_unique', 'txHash_1_sparse_unique']) {
    try {
      await collection.dropIndex(name);
      console.log(`[Migration 032] Dropped index: ${name}`);
    } catch (err) {
      if (err.codeName !== 'IndexNotFound') {
        throw err;
      }
    }
  }

  console.log('[Migration 032] down() intentionally avoids recreating the legacy global txHash unique index; multi-school data cannot be safely rolled back to that constraint.');
}

module.exports = { version: VERSION, up, down };
