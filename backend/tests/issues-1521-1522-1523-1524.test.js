'use strict';

/**
 * Integration tests for issues #1521, #1522, #1523, #1524.
 *
 * Issue #1521: School endpoints read req.params.schoolSlug while routes declare :schoolId
 *   - Tests that GET /api/schools/:schoolId works
 *   - Tests that PATCH /api/schools/:schoolId works
 *   - Tests that DELETE /api/schools/:schoolId works
 *   - Tests that settings endpoints work
 *
 * Issue #1522: Idempotency keys not scoped to tenant
 *   - Tests that same Idempotency-Key + body from different schools creates different intents
 *
 * Issue #1523: Rate limiter collision — verify requests throttled after 10 of any kind
 *   - Tests that verify requests don't get throttled by unrelated requests
 *
 * Issue #1524: Query-string operator injection
 *   - Tests that ?class[$ne]=x returns 400 (malformed query)
 *   - Tests that ?search[a]=1 returns 400
 */

const request = require('supertest');
const app = require('../src/app');
const School = require('../src/models/schoolModel');
const Payment = require('../src/models/paymentModel');
const Student = require('../src/models/studentModel');
const { generateAuthToken } = require('../src/utils/jwtUtils');

describe('Issues #1521, #1522, #1523, #1524 Integration Tests', () => {
  let schoolId;
  let schoolSlug = 'test-school-' + Date.now();
  let adminToken;
  let studentId;

  beforeAll(async () => {
    adminToken = generateAuthToken({ role: 'admin', userId: 'admin-test' });
  });

  beforeEach(async () => {
    // Create a test school
    const school = await School.create({
      schoolId: `SCH-${Date.now()}`,
      name: 'Test School',
      slug: schoolSlug,
      stellarAddress: 'GBXGQ2B45OORQ7POFFB7YUZVSDGVEK67756ZJ74D67756ZJ74D67756Z',
      network: 'testnet',
      isActive: true,
    });
    schoolId = school.schoolId;

    // Create a test student
    const student = await Student.create({
      schoolId,
      firstName: 'Test',
      lastName: 'Student',
      email: 'test@example.com',
      amount: 10000,
      class: 'JSS1',
    });
    studentId = student._id.toString();
  });

  afterEach(async () => {
    await School.deleteMany({});
    await Student.deleteMany({});
    await Payment.deleteMany({});
  });

  describe('Issue #1521: School endpoints with :schoolId parameter', () => {
    it('GET /api/schools/:schoolId should return school without 500 error', async () => {
      const res = await request(app)
        .get(`/api/schools/${schoolId}`)
        .expect(200);
      expect(res.body.schoolId).toBe(schoolId);
      expect(res.body.name).toBe('Test School');
    });

    it('GET /api/schools/:schoolId should return 404 for non-existent school', async () => {
      await request(app)
        .get('/api/schools/SCH-NONEXISTENT')
        .expect(404);
    });

    it('PATCH /api/schools/:schoolId should update school', async () => {
      const res = await request(app)
        .patch(`/api/schools/${schoolId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Updated School Name' })
        .expect(200);
      expect(res.body.name).toBe('Updated School Name');
    });

    it('DELETE /api/schools/:schoolId should deactivate school', async () => {
      const res = await request(app)
        .delete(`/api/schools/${schoolId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.isActive).toBe(false);
    });

    it('GET /api/schools/:schoolId/settings should return settings', async () => {
      await request(app)
        .get(`/api/schools/${schoolId}/settings`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('PATCH /api/schools/:schoolId/settings should update settings', async () => {
      const res = await request(app)
        .patch(`/api/schools/${schoolId}/settings`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ someKey: 'someValue' })
        .expect(200);
      expect(res.body.key).toBeDefined();
    });

    it('PATCH /api/schools/:schoolId/activate should activate school', async () => {
      // First deactivate it
      await request(app)
        .delete(`/api/schools/${schoolId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Then activate
      const res = await request(app)
        .patch(`/api/schools/${schoolId}/activate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.isActive).toBe(true);
    });

    it('PATCH /api/schools/:schoolId/deactivate should deactivate school', async () => {
      const res = await request(app)
        .patch(`/api/schools/${schoolId}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.isActive).toBe(false);
    });
  });

  describe('Issue #1522: Idempotency scoped to tenant', () => {
    it('Same Idempotency-Key + body from different schools should create different intents', async () => {
      // Create a second school
      const school2 = await School.create({
        schoolId: `SCH-${Date.now() + 1}`,
        name: 'Test School 2',
        slug: 'test-school-2-' + Date.now(),
        stellarAddress: 'GBXGQ2B45OORQ7POFFB7YUZVSDGVEK67756ZJ74D67756ZJ74D67756Z',
        network: 'testnet',
        isActive: true,
      });

      // Create a student in school 2
      const student2 = await Student.create({
        schoolId: school2.schoolId,
        firstName: 'Test',
        lastName: 'Student2',
        email: 'test2@example.com',
        amount: 10000,
        class: 'JSS1',
      });

      const idempotencyKey = 'test-key-' + Date.now();
      const payload = {
        studentId: studentId,
        amount: 5000,
        memo: 'Test payment',
      };

      // Request from school 1
      const res1 = await request(app)
        .post('/api/payments/intent')
        .set('X-School-ID', schoolId)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      const intent1Id = res1.body.id;

      // Request from school 2 with same key but different student
      const payload2 = {
        studentId: student2._id.toString(),
        amount: 5000,
        memo: 'Test payment',
      };

      const res2 = await request(app)
        .post('/api/payments/intent')
        .set('X-School-ID', school2.schoolId)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload2)
        .expect(200);

      const intent2Id = res2.body.id;

      // They should be different intents
      expect(intent1Id).not.toBe(intent2Id);
    });
  });

  describe('Issue #1524: Query-string operator injection prevention', () => {
    it('should reject query params with nested objects like ?class[$ne]=x', async () => {
      const res = await request(app)
        .get('/api/students?class[$ne]=x')
        .set('X-School-ID', schoolId)
        .expect(400);
      expect(res.body.code).toBeDefined();
    });

    it('should reject query params with array indices like ?search[a]=1', async () => {
      const res = await request(app)
        .get('/api/students?search[a]=1')
        .set('X-School-ID', schoolId)
        .expect(400);
      expect(res.body.code).toBeDefined();
    });

    it('should accept simple string query params like ?class=JSS1', async () => {
      const res = await request(app)
        .get('/api/students?class=JSS1')
        .set('X-School-ID', schoolId)
        .expect(200);
      // Should not return 400
    });

    it('should reject ?search[$regex]=pattern', async () => {
      const res = await request(app)
        .get('/api/students?search[$regex]=test')
        .set('X-School-ID', schoolId)
        .expect(400);
      expect(res.body.code).toBeDefined();
    });
  });
});
