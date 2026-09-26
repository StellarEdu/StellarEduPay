'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.MONGO_URI = 'mongodb://localhost:27017/test-student-cache';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-for-student-cache-test-minimum-32-chars-long!';
process.env.RECEIPT_SIGNATURE_SECRET = 'test-receipt-secret-student-cache-test-minimum-32-chars!';

let mongoServer;
let app;

require('../backend/src/models/schoolModel');
require('../backend/src/models/studentModel');

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = require('../backend/src/app');
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Issue #1519: Student cache is tenant-scoped', () => {
  let schoolA, schoolB;
  let tokenA, tokenB;

  beforeEach(async () => {
    const School = mongoose.model('School');

    schoolA = await School.create({
      schoolId: 'SCH-STU-A',
      name: 'School A',
      slug: 'school-stu-a',
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      isActive: true,
    });

    schoolB = await School.create({
      schoolId: 'SCH-STU-B',
      name: 'School B',
      slug: 'school-stu-b',
      stellarAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4',
      isActive: true,
    });

    // Generate tokens for each school
    const jwt = require('jsonwebtoken');
    tokenA = jwt.sign({ schoolId: schoolA.schoolId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenB = jwt.sign({ schoolId: schoolB.schoolId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  test('Two students with identical IDs in different schools do not cross-contaminate cache', async () => {
    const Student = mongoose.model('Student');

    await Student.create({
      schoolId: 'SCH-STU-A',
      studentId: 'STU-0001',
      name: 'Alice',
      class: 'Grade 1',
      feeAmount: 100,
    });

    await Student.create({
      schoolId: 'SCH-STU-B',
      studentId: 'STU-0001',
      name: 'Bob',
      class: 'Grade 2',
      feeAmount: 200,
    });

    // Request from School A should return Alice
    const resA1 = await request(app)
      .get('/api/students/STU-0001')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-STU-A');

    expect(resA1.status).toBe(200);
    expect(resA1.body.name).toBe('Alice');
    expect(resA1.body.class).toBe('Grade 1');

    // Request from School B should return Bob (not cached Alice)
    const resB1 = await request(app)
      .get('/api/students/STU-0001')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-STU-B');

    expect(resB1.status).toBe(200);
    expect(resB1.body.name).toBe('Bob');
    expect(resB1.body.class).toBe('Grade 2');

    // Second requests should still return correct data (from cache now)
    const resA2 = await request(app)
      .get('/api/students/STU-0001')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-STU-A');

    expect(resA2.body.name).toBe('Alice');

    const resB2 = await request(app)
      .get('/api/students/STU-0001')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-STU-B');

    expect(resB2.body.name).toBe('Bob');
  });

  test('Public student endpoint returns correct student and respects cache', async () => {
    const Student = mongoose.model('Student');

    await Student.create({
      schoolId: 'SCH-STU-A',
      studentId: 'STU-0002',
      name: 'Charlie',
      class: 'Grade 3',
      feeAmount: 150,
    });

    await Student.create({
      schoolId: 'SCH-STU-B',
      studentId: 'STU-0002',
      name: 'Diana',
      class: 'Grade 4',
      feeAmount: 175,
    });

    // First request from School A
    const resA1 = await request(app)
      .get('/api/students/public/STU-0002')
      .set('X-School-ID', 'SCH-STU-A');

    expect(resA1.status).toBe(200);
    expect(resA1.body.name).toBe('Charlie');

    // First request from School B
    const resB1 = await request(app)
      .get('/api/students/public/STU-0002')
      .set('X-School-ID', 'SCH-STU-B');

    expect(resB1.status).toBe(200);
    expect(resB1.body.name).toBe('Diana');

    // Cached requests should still return correct data
    const resA2 = await request(app)
      .get('/api/students/public/STU-0002')
      .set('X-School-ID', 'SCH-STU-A');

    expect(resA2.body.name).toBe('Charlie');

    const resB2 = await request(app)
      .get('/api/students/public/STU-0002')
      .set('X-School-ID', 'SCH-STU-B');

    expect(resB2.body.name).toBe('Diana');
  });

  test('Deleted students do not appear in public endpoint even from cache', async () => {
    const Student = mongoose.model('Student');

    const student = await Student.create({
      schoolId: 'SCH-STU-A',
      studentId: 'STU-0003',
      name: 'Eve',
      class: 'Grade 5',
      feeAmount: 200,
    });

    // Cache the student
    await request(app)
      .get('/api/students/public/STU-0003')
      .set('X-School-ID', 'SCH-STU-A');

    // Delete the student
    await Student.findOneAndUpdate(
      { schoolId: 'SCH-STU-A', studentId: 'STU-0003' },
      { deletedAt: new Date() }
    );

    // Public endpoint should not return the deleted student
    const res = await request(app)
      .get('/api/students/public/STU-0003')
      .set('X-School-ID', 'SCH-STU-A');

    expect(res.status).toBe(404);
  });

  test('Student update invalidates cache for correct school only', async () => {
    const Student = mongoose.model('Student');

    await Student.create({
      schoolId: 'SCH-STU-A',
      studentId: 'STU-0004',
      name: 'Frank',
      class: 'Grade 6',
      feeAmount: 100,
    });

    await Student.create({
      schoolId: 'SCH-STU-B',
      studentId: 'STU-0004',
      name: 'Grace',
      class: 'Grade 6',
      feeAmount: 100,
    });

    // Cache both students
    await request(app)
      .get('/api/students/STU-0004')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-STU-A');

    await request(app)
      .get('/api/students/STU-0004')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-STU-B');

    // Update School A's student
    await request(app)
      .patch('/api/students/STU-0004')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-STU-A')
      .send({ name: 'Frank Updated' });

    // School A should get the updated name
    const resA = await request(app)
      .get('/api/students/STU-0004')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-STU-A');

    expect(resA.body.name).toBe('Frank Updated');

    // School B should still get the original name (or correctly query it)
    const resB = await request(app)
      .get('/api/students/STU-0004')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-STU-B');

    expect(resB.body.name).toBe('Grace');
  });
});
