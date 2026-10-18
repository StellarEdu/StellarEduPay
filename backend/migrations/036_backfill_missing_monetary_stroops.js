'use strict';

const { toStroops } = require('../src/utils/stellarAmount');

const mappings = {
  payments: [
    ['amount', 'amountStroops'],
    ['feeAmount', 'feeAmountStroops'],
    ['excessAmount', 'excessAmountStroops'],
    ['underpaidReconciliation.appliedCredit', 'underpaidReconciliation.appliedCreditStroops'],
    ['fiatSnapshot.fiatAmount', 'fiatSnapshot.fiatAmountStroops'],
  ],
  students: [
    ['feeAmount', 'feeAmountStroops'],
    ['totalPaid', 'totalPaidStroops'],
    ['remainingBalance', 'remainingBalanceStroops'],
  ],
};

function readPath(doc, path) {
  return path.split('.').reduce((value, key) => value == null ? value : value[key], doc);
}

async function backfill(db, collectionName, fields) {
  const collection = db.collection(collectionName);
  const cursor = collection.find({});
  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const $set = {};
    for (const [source, target] of fields) {
      const value = readPath(doc, source);
      if (value === null || value === undefined || readPath(doc, target) !== undefined) continue;
      $set[target] = toStroops(value).toString();
    }
    if (Object.keys($set).length) {
      await collection.updateOne({ _id: doc._id }, { $set });
      updated += 1;
    }
  }
  return updated;
}

module.exports = {
  version: '036_backfill_missing_monetary_stroops',
  async up(db) {
    const payments = await backfill(db, 'payments', mappings.payments);
    const students = await backfill(db, 'students', mappings.students);
    console.log(`[036_backfill_missing_monetary_stroops] updated ${payments} payments and ${students} students`);
  },
  async down(db) {
    for (const [collectionName, fields] of Object.entries(mappings)) {
      const $unset = Object.fromEntries(fields.map(([, target]) => [target, '']));
      await db.collection(collectionName).updateMany({}, { $unset });
    }
  },
};
