'use strict';

/**
 * Migration 034: key receipts by (schoolId, txHash, opIndex).
 *
 * - Backfills `opIndex: 0` on every existing receipt.
 * - Drops the old single-field unique index on `txHash` (if present).
 * - Creates the compound unique index `{ schoolId: 1, txHash: 1, opIndex: 1 }`.
 *
 * Idempotent: safe to run multiple times.
 */

const COLLECTION = 'receipts';
const COMPOUND_INDEX_NAME = 'schoolId_1_txHash_1_opIndex_1';
const COMPOUND_INDEX_KEYS = { schoolId: 1, txHash: 1, opIndex: 1 };

async function collectionExists(db, name) {
  const collections = await db
    .listCollections({ name }, { nameOnly: true })
    .toArray();
  return collections.length > 0;
}

async function getIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (err) {
    // NamespaceNotFound — collection does not exist yet.
    if (err && (err.code === 26 || err.codeName === 'NamespaceNotFound')) {
      return [];
    }
    throw err;
  }
}

function isTxHashOnlyUniqueIndex(index) {
  if (!index || !index.key) return false;
  const keys = Object.keys(index.key);
  if (keys.length !== 1 || keys[0] !== 'txHash') return false;
  // Only drop unique indexes; a non-unique txHash index is harmless but we
  // still remove it since it is superseded by the compound index.
  return true;
}

module.exports = {
  async up(db) {
    if (!(await collectionExists(db, COLLECTION))) {
      // Nothing to migrate yet; the model will create the compound index.
      return;
    }

    const collection = db.collection(COLLECTION);

    // 1. Backfill opIndex on every receipt missing it.
    await collection.updateMany(
      { opIndex: { $exists: false } },
      { $set: { opIndex: 0 } }
    );
    await collection.updateMany(
      { opIndex: null },
      { $set: { opIndex: 0 } }
    );

    const indexes = await getIndexes(collection);

    // 2. Drop the old single-field unique index on txHash.
    for (const index of indexes) {
      if (isTxHashOnlyUniqueIndex(index)) {
        try {
          await collection.dropIndex(index.name);
        } catch (err) {
          // IndexNotFound — already dropped by a concurrent run.
          if (err && (err.code === 27 || err.codeName === 'IndexNotFound')) {
            continue;
          }
          throw err;
        }
      }
    }

    // 3. Create the compound unique index if it does not already exist.
    const hasCompound = indexes.some(
      (index) =>
        index.name === COMPOUND_INDEX_NAME ||
        (index.key &&
          Object.keys(index.key).length === 3 &&
          index.key.schoolId === 1 &&
          index.key.txHash === 1 &&
          index.key.opIndex === 1)
    );

    if (!hasCompound) {
      await collection.createIndex(COMPOUND_INDEX_KEYS, {
        unique: true,
        name: COMPOUND_INDEX_NAME,
      });
    }
  },

  async down(db) {
    if (!(await collectionExists(db, COLLECTION))) {
      return;
    }

    const collection = db.collection(COLLECTION);
    const indexes = await getIndexes(collection);

    // Drop the compound unique index.
    for (const index of indexes) {
      const isCompound =
        index.name === COMPOUND_INDEX_NAME ||
        (index.key &&
          Object.keys(index.key).length === 3 &&
          index.key.schoolId === 1 &&
          index.key.txHash === 1 &&
          index.key.opIndex === 1);
      if (isCompound) {
        try {
          await collection.dropIndex(index.name);
        } catch (err) {
          if (err && (err.code === 27 || err.codeName === 'IndexNotFound')) {
            continue;
          }
          throw err;
        }
      }
    }

    // Restore the previous single-field unique index on txHash.
    const hasTxHashUnique = indexes.some(
      (index) =>
        index.key &&
        Object.keys(index.key).length === 1 &&
        index.key.txHash === 1 &&
        index.unique === true
    );

    if (!hasTxHashUnique) {
      await collection.createIndex(
        { txHash: 1 },
        { unique: true, name: 'txHash_1' }
      );
    }
  },
};