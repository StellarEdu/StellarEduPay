'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const crypto = require('crypto');

process.env.MONGO_URI = 'mongodb://localhost:27017/test-school-secrets';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-for-school-secrets-test-minimum-32-chars-long!';
process.env.RECEIPT_SIGNATURE_SECRET = 'test-receipt-secret-school-secrets-test-minimum-32-chars!';

let mongoServer;
let app;

require('../backend/src/models/schoolModel');

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

describe('Issue #1520: School endpoints do not expose secrets', () => {
  const secretFields = ['jwtSecret', 'webhookSecret', 'internalNotes', 'mfaSecret', 'mfaBackupCodes'];

  beforeEach(async () => {
    const School = mongoose.model('School');

    await School.create({
      schoolId: 'SCH-SEC-A',
      name: 'School With Secrets',
      slug: 'school-sec-a',
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      isActive: true,
      jwtSecret: 'this-should-be-hidden-' + crypto.randomBytes(32).toString('hex'),
      webhookSecret: 'this-webhook-secret-should-be-hidden-' + crypto.randomBytes(32).toString('hex'),
      internalNotes: 'Internal notes about school security incidents',
      mfaSecret: 'AES-encrypted-TOTP-secret-should-be-hidden',
      mfaBackupCodes: [
        { hash: 'sha256-hash-of-backup-code-1', used: false },
        { hash: 'sha256-hash-of-backup-code-2', used: false },
      ],
    });
  });

  test('GET /api/schools does not expose secret fields', async () => {
    const res = await request(app).get('/api/schools');

    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThan(0);

    const school = res.body.find(s => s.schoolId === 'SCH-SEC-A');
    expect(school).toBeDefined();

    secretFields.forEach(field => {
      expect(school).not.toHaveProperty(field);
    });

    // Verify safe fields are present
    expect(school.schoolId).toBe('SCH-SEC-A');
    expect(school.name).toBe('School With Secrets');
    expect(school.slug).toBe('school-sec-a');
    expect(school.stellarAddress).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4');
  });

  test('GET /api/schools/:schoolSlug does not expose secret fields', async () => {
    const res = await request(app).get('/api/schools/school-sec-a');

    expect(res.status).toBe(200);
    expect(res.body.schoolId).toBe('SCH-SEC-A');

    secretFields.forEach(field => {
      expect(res.body).not.toHaveProperty(field);
    });

    // Verify safe fields are present
    expect(res.body.name).toBe('School With Secrets');
    expect(res.body.slug).toBe('school-sec-a');
  });

  test('GET /api/schools returns only documented public fields', async () => {
    const res = await request(app).get('/api/schools');

    expect(res.status).toBe(200);
    const school = res.body.find(s => s.schoolId === 'SCH-SEC-A');

    const allowedFields = [
      'schoolId',
      'name',
      'slug',
      'stellarAddress',
      'previousStellarAddress',
      'network',
      'isActive',
      'adminEmail',
      'address',
      'contactEmail',
      'localCurrency',
      'timezone',
      'suspiciousPaymentMultiplier',
      'suspiciousAmountConfig',
      'maxPaymentMultiplier',
      'maxStudents',
      'logoUrl',
      'supportContact',
      'primaryColor',
      'emailLocale',
      'maintenanceMode',
      'webhookPayloadConfig',
      'classOptions',
      'createdAt',
      'updatedAt',
      '_id',
      '__v',
    ];

    Object.keys(school).forEach(field => {
      expect(allowedFields).toContain(field);
    });
  });

  test('Public school listing is anonymized — no auth required', async () => {
    // This should work without any authentication
    const res = await request(app).get('/api/schools');

    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);

    const school = res.body.find(s => s.schoolId === 'SCH-SEC-A');
    expect(school).toBeDefined();
    expect(school.name).toBe('School With Secrets');

    // Secret fields should never be exposed
    secretFields.forEach(field => {
      expect(school).not.toHaveProperty(field);
    });
  });

  test('Active schools are returned by default', async () => {
    const res = await request(app).get('/api/schools');

    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);

    const school = res.body.find(s => s.schoolId === 'SCH-SEC-A');
    expect(school).toBeDefined();
    expect(school.isActive).toBe(true);
  });

  test('No password/secret fields in response', async () => {
    const res = await request(app).get('/api/schools/school-sec-a');

    expect(res.status).toBe(200);

    const response = JSON.stringify(res.body);

    // Check that no secret-containing values appear
    expect(response).not.toContain('this-should-be-hidden');
    expect(response).not.toContain('this-webhook-secret-should-be-hidden');
    expect(response).not.toContain('Internal notes about school');
    expect(response).not.toContain('AES-encrypted-TOTP-secret');
  });
});
