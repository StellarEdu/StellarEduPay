'use strict';

/**
 * Tests for issue #1525 — refund history and receipt generation are readable
 * without authentication.
 *
 * Three routes in paymentRoutes.js were left without auth middleware:
 * - GET /receipt/:txHash
 * - GET /:txHash/refunds
 * - GET /verify/:receiptId
 *
 * Acceptance criteria:
 * - Anonymous requests to refund listings return 401
 * - Receipts are not retrievable by tx hash alone without authentication or receipt-specific secret
 * - The authentication-enforcement test enumerates every route in paymentRoutes.js and asserts its expected auth level
 */

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('../src/config/redisClient', () => ({
  getRedisClient: jest.fn(),
  isRedisReady: jest.fn(() => false),
}));

jest.mock('../src/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));

jest.mock('../src/services/alertService', () => ({
  sendAdminAlert: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const paymentAdminController = require('../src/controllers/paymentAdminController');
const authMiddleware = require('../src/middleware/auth');
const { resolveSchool } = require('../src/middleware/schoolContext');

const testSecret = process.env.JWT_SECRET || 'test-secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(resolveSchool);

  // Unauthenticated endpoints
  app.get('/public/instructions/:studentId', (req, res) => {
    res.json({ walletAddress: '0x123' });
  });

  // Currently unprotected (should be protected)
  app.get('/receipt/:txHash', paymentAdminController.generateReceipt);
  app.get('/:txHash/refunds', paymentAdminController.getPaymentRefunds);
  app.get('/verify/:receiptId', paymentAdminController.verifyReceipt);

  // Protected endpoints
  app.get('/protected', authMiddleware.requireSchoolAuth(), (req, res) => {
    res.json({ ok: true });
  });
  app.get('/admin-protected', authMiddleware.requireAdminAuth, (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

function createToken(userId, schoolId, roles = ['admin']) {
  return jwt.sign(
    {
      userId,
      schoolId,
      role: roles[0],
      roles,
    },
    testSecret,
    { expiresIn: '1h' }
  );
}

describe('Issue #1525: Authentication enforcement on payment endpoints', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  describe('Unauthenticated access to refunds and receipts', () => {
    it('should reject anonymous requests to refund listings', async () => {
      const res = await request(app)
        .get('/tx-hash-123/refunds')
        .set('X-School-ID', 'school-123')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    it('should reject anonymous requests to receipt generation', async () => {
      const res = await request(app)
        .get('/receipt/tx-hash-123')
        .set('X-School-ID', 'school-123')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    it('should reject anonymous requests to receipt verification', async () => {
      const res = await request(app)
        .get('/verify/receipt-id-123')
        .set('X-School-ID', 'school-123')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });
  });

  describe('Authenticated access to refunds and receipts', () => {
    it('should allow authenticated users to view their school refunds', async () => {
      const token = createToken('user-1', 'school-123', ['admin']);

      const res = await request(app)
        .get('/tx-hash-123/refunds')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body).toBeDefined();
    });

    it('should allow authenticated users to generate receipts', async () => {
      const token = createToken('user-1', 'school-123', ['admin']);

      const res = await request(app)
        .get('/receipt/tx-hash-123')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body).toBeDefined();
    });

    it('should allow authenticated users to verify receipts', async () => {
      const token = createToken('user-1', 'school-123', ['admin']);

      const res = await request(app)
        .get('/verify/receipt-id-123')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body).toBeDefined();
    });

    it('should only show receipts for the user school', async () => {
      const token = createToken('user-1', 'school-123', ['admin']);

      const res = await request(app)
        .get('/receipt/tx-hash-456')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-999')
        .expect(403);

      expect(res.body.code).toBe('SCHOOL_MISMATCH');
    });
  });

  describe('Cross-tenant protection', () => {
    it('should not allow school-123 user to access school-456 refunds with cross-tenant header', async () => {
      const token = createToken('user-1', 'school-123', ['admin']);

      const res = await request(app)
        .get('/tx-hash-456/refunds')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-456')
        .expect(403);

      expect(res.body.code).toContain('SCHOOL_MISMATCH');
    });
  });

  describe('Public endpoints remain public', () => {
    it('should allow anonymous access to payment instructions', async () => {
      const res = await request(app)
        .get('/public/instructions/student-123')
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body.walletAddress).toBe('0x123');
    });
  });

  describe('Authentication enforcement summary', () => {
    it('should enforce authentication on protected endpoint', async () => {
      const res = await request(app)
        .get('/protected')
        .set('X-School-ID', 'school-123')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    it('should enforce admin authentication on admin endpoint', async () => {
      const res = await request(app)
        .get('/admin-protected')
        .expect(401);

      expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
    });

    it('should allow authenticated access to protected endpoint', async () => {
      const token = createToken('user-1', 'school-123', ['admin']);

      const res = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body.ok).toBe(true);
    });
  });

  describe('Role-based access control on receipt operations', () => {
    it('should allow finance role to access receipts', async () => {
      const token = createToken('user-1', 'school-123', ['finance']);

      const res = await request(app)
        .get('/receipt/tx-hash-123')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body).toBeDefined();
    });

    it('should allow owner role to access receipts', async () => {
      const token = createToken('user-1', 'school-123', ['owner']);

      const res = await request(app)
        .get('/receipt/tx-hash-123')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body).toBeDefined();
    });

    it('should allow staff role to access receipts', async () => {
      const token = createToken('user-1', 'school-123', ['staff']);

      const res = await request(app)
        .get('/receipt/tx-hash-123')
        .set('Authorization', `Bearer ${token}`)
        .set('X-School-ID', 'school-123')
        .expect(200);

      expect(res.body).toBeDefined();
    });
  });
});
