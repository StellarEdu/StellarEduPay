'use strict';

/**
 * Migration 035: Backfill monetary amounts to exact integer stroops.
 *
 * Issue #1559: monetary values were persisted as IEEE-754 doubles, so
 * aggregations ($sum) accumulated rounding error and totals could drift
 * from the sum of their line items. This migration adds exact integer
 * stroop fields (amountStroops, feeAmountStroops, ...) alongside the
 * legacy double fields. The legacy fields are kept until the switch to
 * the stroop fields is complete, so this migration is non-destructive.
 *
 * Conversion is centralised in utils/stellarAmount.js (toStroops) so the
 * backfill uses the same exact 7-decimal fixed-point logic as the runtime.
 */

const { toStroops } = require('../src/utils/stellarAmount');

const STROOP_FIELD_SUFFIX = 'Stroops';

// Monetary fields that must be stored exactly. Each entry maps a legacy
// double field to its exact integer stroop counterpart.
const PAYMENT_MONEY_FIELDS = [
  'amount',
  'feeAmount',
  'excessAmount',
  'appliedCredit',
  'fiatAmount',
];

const STUDENT_MONEY_FIELDS = [
  'feeAmount',
  'totalPaid',
  'remainingBalance',
];

function stroopFieldName(field) {
  return `${field}${STROOP_FIELD_SUFFIX}`;
}

/**
 * Convert a legacy double money value to an exact integer stroop string.
 * Returns undefined when the value is missing or not a finite number so
 * we never write a bogus stroop value.
 */
function toStroopsOrUndefined(value) {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return toStroops(numeric);
}

/**
 * Build the $set document that adds exact stroop fields for every money
 * field present on the source document. Nested fields (e.g.
 * underpaidReconciliation.appliedCredit, fiatSnapshot.fiatAmount) are
 * addressed with dot notation so the legacy nested value is preserved.
 */
function buildStroopSet(doc, fields) {
  const set = {};
  for (const field of fields) {
    const value = field.includes('.')
      ? field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), doc)
      : doc[field];
    const stroops = toStroopsOrUndefined(value);
    if (stroops !== undefined) {
      set[stroopFieldName(field)] = stroops;
    }
  }
  return set;
}

async function backfillCollection(db, collectionName, fields, filter) {
  const collection = db.collection(collectionName);
  const cursor = collection.find(filter || {});

  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const set = buildStroopSet(doc, fields);
    if (Object.keys(set).length === 0) continue;
    await collection.updateOne({ _id: doc._id }, { $set: set });
    updated += 1;
  }

  return updated;
}

module.exports = {
  async up(db) {
    const paymentsUpdated = await backfillCollection(
      db,
      'payments',
      PAYMENT_MONEY_FIELDS,
    );

    const studentsUpdated = await backfillCollection(
      db,
      'students',
      STUDENT_MONEY_FIELDS,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[035_backfill_monetary_stroops] backfilled ${paymentsUpdated} payments and ${studentsUpdated} students`,
    );
  },

  async down(db) {
    // The legacy double fields are never removed, so rolling back only
    // needs to drop the exact stroop fields added by this migration.
    const unset = {};
    for (const field of PAYMENT_MONEY_FIELDS) {
      unset[stroopFieldName(field)] = '';
    }
    await db.collection('payments').updateMany({}, { $unset: unset });

    const studentUnset = {};
    for (const field of STUDENT_MONEY_FIELDS) {
      studentUnset[stroopFieldName(field)] = '';
    }
    await db.collection('students').updateMany({}, { $unset: studentUnset });
  },
};
