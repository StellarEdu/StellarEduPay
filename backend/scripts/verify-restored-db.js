#!/usr/bin/env node
'use strict';

/**
 * Restored-backup consistency check (issue #1630).
 *
 * Run against a SCRATCH database that a backup has just been restored into —
 * never against production. Checks the cross-collection invariants a
 * non-point-in-time backup would break, without contacting Horizon:
 *
 *   - every student's stored totalPaid / remainingBalance matches the sum of
 *     its SUCCESS payments plus creditAdjustments (the same rule as
 *     consistencyService.checkStudentBalanceConsistency, but read-only)
 *   - every SUCCESS payment references a student that exists in the restore
 *
 *   MONGO_URI=mongodb://localhost:27017/stellaredupay node scripts/verify-restored-db.js
 *
 * Exits 0 when the restore is consistent, 1 otherwise. Set
 * VERIFY_FAIL_ON_DRIFT=false to report (not fail on) balance drift, e.g. while
 * a known drift is waiting for the consistency job to repair it in production.
 */

const mongoose = require('mongoose');

const EPSILON = 0.0000001;
const MAX_REPORTED = 20;

async function checkBalances(db) {
  const students = db.collection('students');
  const payments = db.collection('payments');
  const drift = [];

  const totals = new Map();
  const cursor = payments.aggregate([
    { $match: { status: 'SUCCESS', deletedAt: null } },
    { $group: { _id: { schoolId: '$schoolId', studentId: '$studentId' }, total: { $sum: '$amount' } } },
  ]);
  for await (const row of cursor) {
    totals.set(`${row._id.schoolId}\u0000${row._id.studentId}`, row.total);
  }

  const known = new Set();
  let checked = 0;
  for await (const student of students.find({ deletedAt: null })) {
    checked++;
    const key = `${student.schoolId}\u0000${student.studentId}`;
    known.add(key);
    const computedTotal = parseFloat(((totals.get(key) || 0) + (student.creditAdjustments || 0)).toFixed(7));
    const computedRemaining = Math.max(0, (student.feeAmount || 0) - computedTotal);
    const totalDrift = Math.abs(computedTotal - (student.totalPaid || 0));
    const remainingDrift = Math.abs(computedRemaining - (student.remainingBalance || 0));
    if (totalDrift > EPSILON || remainingDrift > EPSILON) {
      drift.push({
        schoolId: student.schoolId,
        studentId: student.studentId,
        storedTotal: student.totalPaid || 0,
        computedTotal,
      });
    }
  }

  const orphans = [...totals.keys()]
    .filter((key) => !known.has(key))
    .map((key) => {
      const [schoolId, studentId] = key.split('\u0000');
      return { schoolId, studentId };
    });

  return { checked, drift, orphans };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('[verify-restored-db] MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30_000 });
  const { checked, drift, orphans } = await checkBalances(mongoose.connection.db);
  await mongoose.disconnect();

  console.log(`[verify-restored-db] Students checked: ${checked}`);
  if (drift.length) {
    console.error(`[verify-restored-db] ${drift.length} student balance(s) disagree with their payments:`);
    drift.slice(0, MAX_REPORTED).forEach((d) => console.error('   ', JSON.stringify(d)));
  }
  if (orphans.length) {
    console.error(`[verify-restored-db] ${orphans.length} student(s) with SUCCESS payments are missing from the restore:`);
    orphans.slice(0, MAX_REPORTED).forEach((o) => console.error('   ', JSON.stringify(o)));
  }
  const failOnDrift = process.env.VERIFY_FAIL_ON_DRIFT !== 'false';
  if ((failOnDrift && drift.length) || orphans.length) {
    console.error('[verify-restored-db] FAIL — restored collections are not mutually consistent');
    process.exit(1);
  }
  console.log('[verify-restored-db] PASS — balances and payments are consistent');
}

main().catch((err) => {
  console.error('[verify-restored-db] Check failed:', err);
  process.exit(1);
});
