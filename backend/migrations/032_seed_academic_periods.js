'use strict';

/**
 * Migration 032 — Seed default academic periods for existing schools (Issue #1569)
 *
 * For each existing school that has no AcademicPeriod documents, this
 * migration creates one period covering the current calendar year and marks
 * it as the current period.  This is the minimal representation needed so all
 * existing fee and payment data falls within at least one period.
 *
 * The migration is idempotent: if a school already has a period, it is skipped.
 */

const mongoose = require('mongoose');

const VERSION = '032_seed_academic_periods';

async function up() {
  const schoolCollection = mongoose.connection.collection('schools');
  const periodCollection = mongoose.connection.collection('academicperiods');

  const schools = await schoolCollection.find({ isActive: true }).toArray();
  const year = new Date().getUTCFullYear();

  let created = 0;
  for (const school of schools) {
    const schoolId = school.schoolId;
    const exists = await periodCollection.findOne({ schoolId });
    if (exists) {
      console.log(`[032] Skipping school ${schoolId} — period already exists`);
      continue;
    }

    const name = `${year} Default Period`;
    await periodCollection.insertOne({
      schoolId,
      name,
      startsAt: new Date(`${year}-01-01T00:00:00.000Z`),
      endsAt: new Date(`${year}-12-31T23:59:59.999Z`),
      isCurrent: true,
      isClosed: false,
      carriedForwardArrears: 0,
      notes: 'Auto-created during migration to cover existing data',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`[032] Created default period "${name}" for school ${schoolId}`);
    created++;
  }

  // Create indexes on the new collection.
  await periodCollection.createIndex({ schoolId: 1, name: 1 }, { unique: true });
  await periodCollection.createIndex({ schoolId: 1, isCurrent: 1 });
  await periodCollection.createIndex({ schoolId: 1, startsAt: 1 });

  console.log(`[032] Done. Created ${created} default period(s). Indexes ensured.`);
}

async function down() {
  const periodCollection = mongoose.connection.collection('academicperiods');
  // Only remove auto-created migration periods, not user-created ones.
  const result = await periodCollection.deleteMany({
    notes: 'Auto-created during migration to cover existing data',
  });
  console.log(`[032] Removed ${result.deletedCount} auto-created period(s).`);
}

module.exports = { version: VERSION, up, down };
