'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.MONGO_URI = 'mongodb://localhost:27017/test-fee-cache';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-for-fee-cache-test-minimum-32-chars-long!';
process.env.RECEIPT_SIGNATURE_SECRET = 'test-receipt-secret-fee-cache-test-minimum-32-chars!';

let mongoServer;
let app;

require('../backend/src/models/schoolModel');
require('../backend/src/models/feeStructureModel');

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

describe('Issue #1518: Fee structure cache is tenant-scoped', () => {
  let schoolA, schoolB;
  let tokenA, tokenB;

  beforeEach(async () => {
    const School = mongoose.model('School');

    schoolA = await School.create({
      schoolId: 'SCH-FEE-A',
      name: 'School A',
      slug: 'school-fee-a',
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      isActive: true,
    });

    schoolB = await School.create({
      schoolId: 'SCH-FEE-B',
      name: 'School B',
      slug: 'school-fee-b',
      stellarAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4',
      isActive: true,
    });

    // Generate tokens for each school
    const jwt = require('jsonwebtoken');
    tokenA = jwt.sign({ schoolId: schoolA.schoolId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenB = jwt.sign({ schoolId: schoolB.schoolId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  test('Two schools with the same class name receive their own fee structures', async () => {
    const FeeStructure = mongoose.model('FeeStructure');

    await FeeStructure.create({
      schoolId: 'SCH-FEE-A',
      className: 'Grade 1',
      feeAmount: 100,
      isActive: true,
    });

    await FeeStructure.create({
      schoolId: 'SCH-FEE-B',
      className: 'Grade 1',
      feeAmount: 200,
      isActive: true,
    });

    const resA = await request(app)
      .get('/api/fees/Grade%201')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-FEE-A');

    const resB = await request(app)
      .get('/api/fees/Grade%201')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-FEE-B');

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.feeAmount).toBe(100);
    expect(resB.body.feeAmount).toBe(200);
  });

  test('GET /api/fees returns correct school fee structures with caching', async () => {
    const FeeStructure = mongoose.model('FeeStructure');

    await FeeStructure.create({
      schoolId: 'SCH-FEE-A',
      className: 'Class A',
      feeAmount: 150,
      isActive: true,
    });

    await FeeStructure.create({
      schoolId: 'SCH-FEE-B',
      className: 'Class B',
      feeAmount: 250,
      isActive: true,
    });

    const resA1 = await request(app)
      .get('/api/fees')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-FEE-A');

    const resB1 = await request(app)
      .get('/api/fees')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-FEE-B');

    expect(resA1.status).toBe(200);
    expect(resB1.status).toBe(200);

    const feeA = resA1.body.data.find(f => f.schoolId === 'SCH-FEE-A');
    const feeB = resB1.body.data.find(f => f.schoolId === 'SCH-FEE-B');

    expect(feeA.feeAmount).toBe(150);
    expect(feeB.feeAmount).toBe(250);

    // Second request should hit cache but still return correct data
    const resA2 = await request(app)
      .get('/api/fees')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-FEE-A');

    const resB2 = await request(app)
      .get('/api/fees')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-FEE-B');

    const feeA2 = resA2.body.data.find(f => f.schoolId === 'SCH-FEE-A');
    const feeB2 = resB2.body.data.find(f => f.schoolId === 'SCH-FEE-B');

    expect(feeA2.feeAmount).toBe(150);
    expect(feeB2.feeAmount).toBe(250);
  });

  test('Cache invalidation for one school does not affect another', async () => {
    const FeeStructure = mongoose.model('FeeStructure');

    const feeA = await FeeStructure.create({
      schoolId: 'SCH-FEE-A',
      className: 'Math',
      feeAmount: 50,
      isActive: true,
    });

    await FeeStructure.create({
      schoolId: 'SCH-FEE-B',
      className: 'Math',
      feeAmount: 75,
      isActive: true,
    });

    // Fetch and cache both
    await request(app)
      .get('/api/fees/Math')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-FEE-A');

    await request(app)
      .get('/api/fees/Math')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-FEE-B');

    // Update fee in school A
    await request(app)
      .patch(`/api/fees/Math`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-FEE-A')
      .send({ feeAmount: 60 });

    // School A should get the new value
    const resA = await request(app)
      .get('/api/fees/Math')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-School-ID', 'SCH-FEE-A');

    expect(resA.body.feeAmount).toBe(60);

    // School B should still get the old cached value or correctly query it
    const resB = await request(app)
      .get('/api/fees/Math')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-School-ID', 'SCH-FEE-B');

    expect(resB.body.feeAmount).toBe(75);
  });
});
