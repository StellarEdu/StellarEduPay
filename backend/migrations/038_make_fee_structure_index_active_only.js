'use strict';

/**
 * Replace the legacy unconditional school/class unique index with a partial
 * unique index so inactive fee structures remain as history (#2030).
 */

const VERSION = '038_make_fee_structure_index_active_only';
const LEGACY_INDEX = 'schoolId_1_className_1';
const ACTIVE_INDEX = 'uniq_active_fee_structure_per_class';

async function dropIfPresent(collection, name) {
  try {
    await collection.dropIndex(name);
  } catch (err) {
    if (err.code !== 26 && err.code !== 27) throw err;
  }
}

module.exports = {
  version: VERSION,

  async up(db) {
    const collection = db.collection('feestructures');
    await dropIfPresent(collection, LEGACY_INDEX);
    await collection.createIndex(
      { schoolId: 1, className: 1 },
      {
        name: ACTIVE_INDEX,
        unique: true,
        partialFilterExpression: { isActive: true },
      }
    );
  },

  async down(db) {
    const collection = db.collection('feestructures');
    await dropIfPresent(collection, ACTIVE_INDEX);
    await collection.createIndex(
      { schoolId: 1, className: 1 },
      { name: LEGACY_INDEX, unique: true }
    );
  },
};
