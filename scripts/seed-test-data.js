#!/usr/bin/env node
'use strict';

/**
 * Seed script — populates the database with a sample school plus fee structures
 * and students scoped to it, for local development and testing.
 *
 * This app is multi-tenant: Student and FeeStructure are tenant-scoped (every
 * document and query must carry a schoolId), and the API resolves the active
 * tenant from the X-School-ID / X-School-Slug header. So the seed first creates
 * a School whose schoolId matches the frontend's default (SCH001), then seeds
 * fees and students under that schoolId — otherwise the dashboard's scoped
 * endpoints return "School not found" / empty results.
 *
 * Usage:
 *   node scripts/seed-test-data.js           # upsert (safe default)
 *   node scripts/seed-test-data.js --clean   # drop this school's data then re-seed
 *
 * Requirements:
 *   - backend/.env must exist with MONGO_URI and a valid SCHOOL_WALLET_ADDRESS
 *     (a real Stellar public key — the School model validates it).
 *   - MongoDB must be running.
 *
 * Env overrides (optional): SEED_SCHOOL_ID (default SCH001),
 *   SEED_SCHOOL_SLUG (default demo-school), SEED_SCHOOL_NAME (default Demo School).
 *
 * Safe to re-run: all writes use upsert so repeated runs produce identical records.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

// Patch env so config/index.js validation passes when models are loaded.
process.env.SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || 'PLACEHOLDER';

// Root and backend pin different mongoose majors in separate node_modules
// trees. A plain require('mongoose') here resolves to the root copy, which is
// a different singleton than the one the models are bound to — mongoose.connect()
// below would then never open *their* connection, and every query buffers until
// it times out ("buffering timeout" — see issue #749).
const mongoose = require('../backend/node_modules/mongoose');
const School = require('../backend/src/models/schoolModel');
const FeeStructure = require('../backend/src/models/feeStructureModel');
const Student = require('../backend/src/models/studentModel');

const POOL_CONFIG = {
  maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE || process.env.DB_MAX_POOL_SIZE || '20', 10),
  minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '10', 10),
  maxIdleTimeMS: parseInt(process.env.DB_MAX_IDLE_TIME_MS || '30000', 10),
  connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS || '45000', 10),
  serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
};

// ── Seed data ─────────────────────────────────────────────────────────────────

// The tenant the seeded data belongs to. schoolId defaults to SCH001 to match
// the frontend's default X-School-ID (frontend/src/services/api.js).
const SCHOOL = {
  schoolId: process.env.SEED_SCHOOL_ID || 'SCH001',
  slug: (process.env.SEED_SCHOOL_SLUG || 'demo-school').toLowerCase(),
  name: process.env.SEED_SCHOOL_NAME || 'Demo School',
  stellarAddress: process.env.SCHOOL_WALLET_ADDRESS,
  network: process.env.STELLAR_NETWORK || 'testnet',
};

const FEE_STRUCTURES = [
  { className: 'Grade 9',  feeAmount: 500,  description: 'Junior Secondary' },
  { className: 'Grade 10', feeAmount: 550,  description: 'Junior Secondary' },
  { className: 'Grade 11', feeAmount: 600,  description: 'Senior Secondary' },
  { className: 'Grade 12', feeAmount: 650,  description: 'Senior Secondary' },
];

const STUDENTS = [
  { studentId: 'STU001', name: 'Alice Johnson',   class: 'Grade 9'  },
  { studentId: 'STU002', name: 'Bob Martinez',    class: 'Grade 9'  },
  { studentId: 'STU003', name: 'Carol Williams',  class: 'Grade 10' },
  { studentId: 'STU004', name: 'David Osei',      class: 'Grade 10' },
  { studentId: 'STU005', name: 'Eva Mensah',      class: 'Grade 11' },
  { studentId: 'STU006', name: 'Frank Asante',    class: 'Grade 11' },
  { studentId: 'STU007', name: 'Grace Nkrumah',   class: 'Grade 12' },
  { studentId: 'STU008', name: 'Henry Boateng',   class: 'Grade 12' },
  // One student with a partial payment already recorded (for payment flow testing)
  { studentId: 'STU009', name: 'Irene Adjei',     class: 'Grade 12', totalPaid: 200, remainingBalance: 450 },
  // One student marked as fully paid (for dashboard/filter testing)
  { studentId: 'STU010', name: 'James Owusu',     class: 'Grade 9',  feePaid: true,  totalPaid: 500, remainingBalance: 0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Upsert the tenant School whose schoolId the seeded fees/students belong to.
 * School is not tenant-scoped (it is the tenant root), so no schoolId filter
 * is required here. Returns the resolved schoolId.
 */
async function seedSchool() {
  console.log('\n🏫  Seeding school…');

  if (!/^G[A-Z2-7]{55}$/.test(SCHOOL.stellarAddress || '')) {
    throw new Error(
      `SCHOOL_WALLET_ADDRESS is not a valid Stellar public key ("${SCHOOL.stellarAddress}"). ` +
      'Set a real G... address in backend/.env before seeding.'
    );
  }

  const doc = await School.findOneAndUpdate(
    { schoolId: SCHOOL.schoolId },
    {
      schoolId: SCHOOL.schoolId,
      name: SCHOOL.name,
      slug: SCHOOL.slug,
      stellarAddress: SCHOOL.stellarAddress,
      network: SCHOOL.network,
      isActive: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  console.log(`   ✔  ${doc.schoolId} — ${doc.name} (slug: ${doc.slug}, ${doc.network})`);
  return doc.schoolId;
}

/**
 * Upsert fee structures for the given school — update feeAmount/description if
 * the class already exists so re-runs stay consistent. schoolId is part of the
 * filter (tenant-scoped model) and of the document.
 */
async function seedFeeStructures(schoolId = SCHOOL.schoolId) {
  console.log('\n📋  Seeding fee structures…');
  const feeMap = {};

  for (const fee of FEE_STRUCTURES) {
    const doc = await FeeStructure.findOneAndUpdate(
      { schoolId, className: fee.className },
      { schoolId, ...fee, isActive: true },
      { upsert: true, new: true, runValidators: true }
    );
    feeMap[doc.className] = doc.feeAmount;
    console.log(`   ✔  ${doc.className} — $${doc.feeAmount} USDC`);
  }

  return feeMap;
}

/**
 * Upsert students by (schoolId, studentId) — consistent with the fee structure
 * approach. Resolves feeAmount from the fee map so the seed is self-contained.
 */
async function seedStudents(feeMap, schoolId = SCHOOL.schoolId) {
  console.log('\n🎓  Seeding students…');

  for (const s of STUDENTS) {
    const feeAmount = feeMap[s.class];
    if (!feeAmount) {
      console.warn(`   ⚠️   No fee structure found for class "${s.class}" — skipping ${s.studentId}`);
      continue;
    }

    await Student.findOneAndUpdate(
      { schoolId, studentId: s.studentId },
      { schoolId, feeAmount, ...s },
      { upsert: true, new: true, runValidators: true }
    );
    console.log(`   ✔  ${s.studentId} — ${s.name} (${s.class}, $${feeAmount} USDC)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const clean = process.argv.includes('--clean');
  const MONGO_URI = process.env.MONGO_URI;

  console.log('🌱  StellarEduPay — test data seed');
  console.log(`    MongoDB: ${MONGO_URI}`);
  console.log(`    School:  ${SCHOOL.schoolId} (${SCHOOL.slug})`);
  if (clean) console.log("    Mode: --clean (dropping this school's data before re-seeding)");

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: POOL_CONFIG.maxPoolSize,
    minPoolSize: POOL_CONFIG.minPoolSize,
    maxIdleTimeMS: POOL_CONFIG.maxIdleTimeMS,
    connectTimeoutMS: POOL_CONFIG.connectTimeoutMS,
    socketTimeoutMS: POOL_CONFIG.socketTimeoutMS,
    serverSelectionTimeoutMS: POOL_CONFIG.serverSelectionTimeoutMS,
    retryWrites: true,
    retryReads: true,
    w: 'majority',
    readPreference: 'primaryPreferred',
  });
  console.log('    Connected to MongoDB');

  if (clean) {
    // Scoped deletes — Student/FeeStructure are tenant-scoped, so a filter
    // without schoolId is rejected by the tenantScope plugin.
    await FeeStructure.deleteMany({ schoolId: SCHOOL.schoolId });
    await Student.deleteMany({ schoolId: SCHOOL.schoolId });
    console.log(`    Cleared existing fees/students for ${SCHOOL.schoolId}.`);
  }

  const schoolId = await seedSchool();
  const feeMap = await seedFeeStructures(schoolId);
  await seedStudents(feeMap, schoolId);

  console.log('\n✅  Done.');
  console.log('\n    Quick test commands (note the required X-School-ID header):');
  console.log(`      curl -H 'X-School-ID: ${SCHOOL.schoolId}' http://localhost:5000/api/students`);
  console.log(`      curl -H 'X-School-ID: ${SCHOOL.schoolId}' http://localhost:5000/api/fees`);
  console.log(`      curl -H 'X-School-ID: ${SCHOOL.schoolId}' http://localhost:5000/api/students/STU001\n`);
}

// Only validate env and run when executed directly (not when require()'d by tests)
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error('❌  MONGO_URI is not set. Check backend/.env');
    process.exit(1);
  }

  main()
    .catch((err) => {
      console.error('\n❌  Seed failed:', err.message);
      process.exit(1);
    })
    .finally(() => mongoose.disconnect());
}

module.exports = { seedSchool, seedFeeStructures, seedStudents, SCHOOL, FEE_STRUCTURES, STUDENTS };
