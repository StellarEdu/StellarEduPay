'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const Student = require('../src/models/studentModel');
const migration = require('../migrations/038_optimize_student_tenant_indexes');

jest.setTimeout(120000);

function hasIxscan(plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (plan.stage === 'IXSCAN') return true;
  return Object.values(plan).some((value) =>
    Array.isArray(value) ? value.some(hasIxscan) : hasIxscan(value)
  );
}

describe('student tenant query indexes (#2031)', () => {
  let server;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    const collection = mongoose.connection.db.collection('students');
    const docs = Array.from({ length: 10000 }, (_, i) => ({
      schoolId: `school-${i % 10}`,
      studentId: `STU-${String(i).padStart(5, '0')}`,
      studentIdLower: `stu-${String(i).padStart(5, '0')}`,
      name: `Student ${i}`,
      nameLower: `student ${i}`,
      class: `class-${i % 6}`,
      feeAmount: 100,
      feePaid: i % 3 === 0,
      totalPaid: i % 3 === 1 ? 50 : 0,
      paymentDeadline: new Date(Date.now() - (i % 2) * 86400000),
      reminderOptOut: false,
      parentEmail: i % 2 ? `parent${i}@example.test` : null,
      parentPhone: i % 2 ? null : `+1555${String(i).padStart(7, '0')}`,
      deletedAt: null,
      createdAt: new Date(Date.now() - i * 1000),
      updatedAt: new Date(),
    }));
    await collection.insertMany(docs);
    await migration.up(mongoose.connection.db);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  test.each([
    ['list', { schoolId: 'school-1', deletedAt: null }, { createdAt: -1 }],
    ['search', { schoolId: 'school-1', deletedAt: null, nameLower: /^student 1/ }, null],
    ['reminder', { schoolId: 'school-1', deletedAt: null, feePaid: false, reminderOptOut: { $ne: true }, parentEmail: { $ne: null } }, null],
    ['overdue', { schoolId: 'school-1', deletedAt: null, feePaid: false, paymentDeadline: { $lt: new Date() } }, null],
  ])('%s query uses an index', async (_name, filter, sort) => {
    let cursor = mongoose.connection.db.collection('students').find(filter);
    if (sort) cursor = cursor.sort(sort);
    const explanation = await cursor.explain('queryPlanner');
    expect(hasIxscan(explanation.queryPlanner.winningPlan)).toBe(true);
  });
});
