/**
 * Migration 001 — Backfill remainingBalance on existing students.
 * Sets remainingBalance = feeAmount - totalPaid for any student where it is null.
 *
 * Uses the native driver collection rather than the Student model so the
 * migration is not blocked by the tenantScope plugin (which requires a schoolId
 * on every model query) — matching the pattern used by the other data-backfill
 * migrations (e.g. 005, 010, 012).
 */
const mongoose = require('mongoose');

const COLLECTION = 'students';

module.exports = {
  version: '001_backfill_remaining_balance',

  async up() {
    await mongoose.connection.collection(COLLECTION).updateMany(
      { remainingBalance: null },
      [{ $set: { remainingBalance: { $subtract: ['$feeAmount', '$totalPaid'] } } }]
    );
  },

  async down() {
    // Only revert students that still hold the exact value up() would have
    // written (remainingBalance === feeAmount - totalPaid). Any student whose
    // balance was legitimately changed after the migration no longer matches
    // and is left untouched, so rollback cannot destroy unrelated updates —
    // unlike the previous updateMany({}, { remainingBalance: null }) which
    // nulled the field for every student regardless of what up() touched.
    await mongoose.connection.collection(COLLECTION).updateMany(
      { $expr: { $eq: ['$remainingBalance', { $subtract: ['$feeAmount', '$totalPaid'] }] } },
      { $set: { remainingBalance: null } }
    );
  },
};
