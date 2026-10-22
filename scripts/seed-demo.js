#!/usr/bin/env node
'use strict';

/**
 * Demo seed for the multi-school architecture.
 * Creates one school (SCH001) plus fee structures, students and payments
 * all scoped to that school, so the dashboard/reports/pay-fees pages show
 * real data. Idempotent (upserts). Intended to run INSIDE the backend
 * container where MONGO_URI + models are already wired up.
 */

const mongoose = require('mongoose');
const path = require('path');

const ROOT = '/app/src/models';
const School        = require(path.join(ROOT, 'schoolModel'));
const FeeStructure  = require(path.join(ROOT, 'feeStructureModel'));
const Student       = require(path.join(ROOT, 'studentModel'));
const Payment       = require(path.join(ROOT, 'paymentModel'));

const SCHOOL_ID = 'SCH001';
const SLUG = 'demo-school';
const WALLET = process.env.SCHOOL_WALLET_ADDRESS || 'GBFEB336WXIM45JSY3JXEM26JKA67XKLTS6UCCAQDOWBZNHA5JALZQST';

const FEES = [
  { className: 'Grade 9',  feeAmount: 500 },
  { className: 'Grade 10', feeAmount: 550 },
  { className: 'Grade 11', feeAmount: 600 },
  { className: 'Grade 12', feeAmount: 650 },
];

const STUDENTS = [
  { studentId: 'STU001', name: 'Alice Johnson',  class: 'Grade 9'  },
  { studentId: 'STU002', name: 'Bob Martinez',   class: 'Grade 9'  },
  { studentId: 'STU003', name: 'Carol Williams', class: 'Grade 10' },
  { studentId: 'STU004', name: 'David Osei',     class: 'Grade 10' },
  { studentId: 'STU005', name: 'Eva Mensah',     class: 'Grade 11' },
  { studentId: 'STU006', name: 'Frank Asante',   class: 'Grade 11' },
  { studentId: 'STU007', name: 'Grace Nkrumah',  class: 'Grade 12' },
  { studentId: 'STU008', name: 'Henry Boateng',  class: 'Grade 12' },
  { studentId: 'STU009', name: 'Irene Adjei',    class: 'Grade 12', partial: true },
  { studentId: 'STU010', name: 'James Owusu',    class: 'Grade 9',  paid: true },
];

function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

const SCALE_MODE = Boolean(process.env.SEED_SCHOOL_COUNT || process.env.SEED_STUDENTS_PER_SCHOOL);
const SCALE_SCHOOL_COUNT = Math.max(1, parseInt(process.env.SEED_SCHOOL_COUNT || '1', 10));
const SCALE_STUDENTS_PER_SCHOOL = Math.max(1, parseInt(process.env.SEED_STUDENTS_PER_SCHOOL || '10', 10));
const SCALE_SCHOOL_PREFIX = process.env.SEED_SCHOOL_ID_PREFIX || 'LOAD';

function scaledSchool(index) {
  const number = String(index + 1).padStart(4, '0');
  return {
    schoolId: `${SCALE_SCHOOL_PREFIX}${number}`,
    name: `${process.env.SEED_SCHOOL_NAME_PREFIX || 'Load Test School'} ${index + 1}`,
    slug: `${(process.env.SEED_SCHOOL_SLUG_PREFIX || 'load-school').toLowerCase()}-${index + 1}`,
    stellarAddress: process.env.SCHOOL_WALLET_ADDRESS || WALLET,
    network: process.env.STELLAR_NETWORK || 'testnet',
    isActive: true,
  };
}

async function seedScaledPopulation() {
  const schoolIds = Array.from({ length: SCALE_SCHOOL_COUNT }, (_, index) => scaledSchool(index).schoolId);
  if (process.env.SEED_CLEAN === 'true') {
    await Promise.all([
      FeeStructure.deleteMany({ schoolId: { $in: schoolIds } }),
      Student.deleteMany({ schoolId: { $in: schoolIds } }),
      School.deleteMany({ schoolId: { $in: schoolIds } }),
    ]);
  }
  let students = 0;
  for (let schoolIndex = 0; schoolIndex < SCALE_SCHOOL_COUNT; schoolIndex += 1) {
    const school = scaledSchool(schoolIndex);
    await School.findOneAndUpdate({ schoolId: school.schoolId }, school, { upsert: true, new: true, runValidators: true });
    const feeMap = {};
    for (const fee of FEES) {
      const doc = await FeeStructure.findOneAndUpdate(
        { schoolId: school.schoolId, className: fee.className },
        { schoolId: school.schoolId, ...fee, isActive: true },
        { upsert: true, new: true, runValidators: true },
      );
      feeMap[doc.className] = doc.feeAmount;
    }
    const operations = [];
    for (let studentIndex = 0; studentIndex < SCALE_STUDENTS_PER_SCHOOL; studentIndex += 1) {
      const className = FEES[studentIndex % FEES.length].className;
      const studentId = `STU${String(studentIndex + 1).padStart(6, '0')}`;
      operations.push({
        updateOne: {
          filter: { schoolId: school.schoolId, studentId },
          update: {
            $set: {
              schoolId: school.schoolId,
              studentId,
              name: `Load Student ${school.schoolId}-${studentIndex + 1}`,
              class: className,
              feeAmount: feeMap[className],
              feePaid: false,
              totalPaid: 0,
              remainingBalance: feeMap[className],
            },
          },
          upsert: true,
        },
      });
      if (operations.length === 1000) {
        await Student.bulkWrite(operations.splice(0), { ordered: false });
      }
    }
    if (operations.length) await Student.bulkWrite(operations, { ordered: false });
    students += SCALE_STUDENTS_PER_SCHOOL;
    if ((schoolIndex + 1) % 10 === 0 || schoolIndex === SCALE_SCHOOL_COUNT - 1) {
      console.log('scaled seed progress:', schoolIndex + 1, '/', SCALE_SCHOOL_COUNT, 'schools;', students, 'students');
    }
  }
  console.log('scaled seed complete:', JSON.stringify({
    schoolCount: SCALE_SCHOOL_COUNT,
    studentsPerSchool: SCALE_STUDENTS_PER_SCHOOL,
    students,
    schoolIdPrefix: SCALE_SCHOOL_PREFIX,
  }));
}

const POOL_CONFIG = {
  maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE || process.env.DB_MAX_POOL_SIZE || '20', 10),
  minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '10', 10),
  maxIdleTimeMS: parseInt(process.env.DB_MAX_IDLE_TIME_MS || '30000', 10),
  connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS || '45000', 10),
  serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI, {
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
  if (SCALE_MODE) {
    await seedScaledPopulation();
    return;
  }
  console.log('connected to', process.env.MONGO_URI.replace(/:\/\/[^@]*@/, '://***@'));

  // 1. School
  await School.findOneAndUpdate(
    { schoolId: SCHOOL_ID },
    { schoolId: SCHOOL_ID, name: 'Demo High School', slug: SLUG, stellarAddress: WALLET, network: 'testnet', isActive: true },
    { upsert: true, new: true, runValidators: true }
  );
  console.log('school:', SCHOOL_ID, '/', SLUG);

  // 2. Fee structures
  const feeMap = {};
  for (const f of FEES) {
    const doc = await FeeStructure.findOneAndUpdate(
      { schoolId: SCHOOL_ID, className: f.className },
      { schoolId: SCHOOL_ID, className: f.className, feeAmount: f.feeAmount, isActive: true },
      { upsert: true, new: true, runValidators: true }
    );
    feeMap[doc.className] = doc.feeAmount;
  }
  console.log('fee structures:', Object.keys(feeMap).length);

  // 3. Students
  for (const s of STUDENTS) {
    const feeAmount = feeMap[s.class];
    const doc = {
      schoolId: SCHOOL_ID, studentId: s.studentId, name: s.name, class: s.class, feeAmount,
      feePaid: !!s.paid,
    };
    await Student.findOneAndUpdate({ schoolId: SCHOOL_ID, studentId: s.studentId }, doc, { upsert: true, new: true, runValidators: true });
  }
  console.log('students:', STUDENTS.length);

  // 4. Payments — give a realistic spread across recent days
  const PAYMENTS = [
    { studentId: 'STU010', class: 'Grade 9',  amount: 500, status: 'valid',     day: 1 },
    { studentId: 'STU001', class: 'Grade 9',  amount: 500, status: 'valid',     day: 2 },
    { studentId: 'STU003', class: 'Grade 10', amount: 600, status: 'overpaid',  day: 2 },
    { studentId: 'STU005', class: 'Grade 11', amount: 600, status: 'valid',     day: 3 },
    { studentId: 'STU009', class: 'Grade 12', amount: 200, status: 'underpaid', day: 4 },
    { studentId: 'STU007', class: 'Grade 12', amount: 650, status: 'valid',     day: 5 },
    { studentId: 'STU002', class: 'Grade 9',  amount: 500, status: 'valid',     day: 6 },
    { studentId: 'STU004', class: 'Grade 10', amount: 550, status: 'valid',     day: 8 },
  ];
  let i = 0;
  for (const p of PAYMENTS) {
    const txHash = ('demo' + p.studentId + p.day).padEnd(64, '0').slice(0, 64);
    await Payment.findOneAndUpdate(
      { schoolId: SCHOOL_ID, txHash },
      {
        schoolId: SCHOOL_ID, studentId: p.studentId, txHash,
        amount: p.amount, feeAmount: feeMap[p.class],
        feeValidationStatus: p.status, status: 'SUCCESS',
        confirmationStatus: 'confirmed',
        assetCode: 'XLM', assetType: 'native',
        memo: p.studentId, senderAddress: 'GDEMO' + 'X'.repeat(51),
        confirmedAt: daysAgo(p.day), verifiedAt: daysAgo(p.day),
      },
      { upsert: true, new: true, runValidators: true }
    );
    i++;
  }
  console.log('payments:', i);

  console.log('\nDONE. School slug: %s  schoolId: %s', SLUG, SCHOOL_ID);
}

main()
  .catch(e => { console.error('SEED ERROR:', e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
