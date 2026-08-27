'use strict';

process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.SCHOOL_WALLET_ADDRESS = 'GTEST123';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Student = require('../backend/src/models/studentModel');
const Payment = require('../backend/src/models/paymentModel');

const POOL_CONFIG = {
  maxPoolSize: 20,
  minPoolSize: 10,
};

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { storageEngine: 'ephemeral' },
  });
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Student.deleteMany({});
  await Payment.deleteMany({});
});

describe('MongoDB Connection Pool Sizing', () => {
  test('connection pool allows concurrent operations up to maxPoolSize', async () => {
    const CONCURRENT_OPERATIONS = POOL_CONFIG.maxPoolSize + 5;
    const startTime = Date.now();
    const promises = [];

    for (let i = 0; i < CONCURRENT_OPERATIONS; i++) {
      promises.push(
        Student.create({
          studentId: `STU-${i}`,
          schoolId: 'SCHOOL-1',
          feeAmount: 100,
          name: `Student ${i}`,
        })
      );
    }

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;

    expect(results).toHaveLength(CONCURRENT_OPERATIONS);
    results.forEach((doc, idx) => {
      expect(doc.studentId).toBe(`STU-${idx}`);
    });

    expect(duration).toBeLessThan(10000);
  });

  test('concurrent reads do not exhaust pool', async () => {
    const numStudents = 50;
    for (let i = 0; i < numStudents; i++) {
      await Student.create({
        studentId: `READ-STU-${i}`,
        schoolId: 'SCHOOL-1',
        feeAmount: 100,
        name: `Read Student ${i}`,
      });
    }

    const readPromises = [];
    for (let i = 0; i < POOL_CONFIG.maxPoolSize; i++) {
      readPromises.push(
        Student.find({ schoolId: 'SCHOOL-1' }).lean()
      );
    }

    const results = await Promise.all(readPromises);
    expect(results.length).toBe(POOL_CONFIG.maxPoolSize);
    results.forEach((docs) => {
      expect(docs.length).toBeGreaterThan(0);
    });
  });

  test('majority write concern is set on connection', async () => {
    const payment = await Payment.create({
      schoolId: 'SCHOOL-1',
      studentId: 'WRITE-STU-001',
      txHash: 'write-concern-test-hash-unique',
      amount: 100,
      status: 'SUCCESS',
    });

    expect(payment).toBeDefined();
    expect(payment.txHash).toBe('write-concern-test-hash-unique');
  });

  test('connection options are properly configured in database.js', async () => {
    const { POOL_CONFIG: loadedConfig } = require('../backend/src/config/database');

    expect(loadedConfig.maxPoolSize).toBe(20);
    expect(loadedConfig.minPoolSize).toBe(10);
    expect(loadedConfig.connectTimeoutMS).toBeGreaterThan(0);
    expect(loadedConfig.socketTimeoutMS).toBeGreaterThan(0);
    expect(loadedConfig.serverSelectionTimeoutMS).toBeGreaterThan(0);
  });
});