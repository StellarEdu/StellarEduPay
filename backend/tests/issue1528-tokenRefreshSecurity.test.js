'use strict';

/**
 * Tests for issue #1528 — token refresh never re-checks the account.
 *
 * Deactivated users and revoked roles keep working for up to 30 days
 * because handleRefresh rebuilds the access token from cached metadata
 * stored at login time, never reloading the User document.
 *
 * Acceptance criteria:
 * - Deactivating a user causes their next refresh to fail
 * - Role/school changes are reflected in the next access token issued
 * - Sessions have an absolute maximum lifetime independent of rotation
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

const authController = require('../src/controllers/authController');
const { getRedisClient } = require('../src/config/redisClient');

// Mock User model
let mockUserDoc = null;

jest.mock('../src/models/userModel', () => ({
  findById: jest.fn(async (id) => {
    if (mockUserDoc && mockUserDoc._id === id) {
      return mockUserDoc;
    }
    return null;
  }),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/refresh', authController.handleRefresh);
  return app;
}

describe('Issue #1528: Token refresh security', () => {
  let app;
  const testSecret = process.env.JWT_SECRET || 'test-secret';
  const testUserId = 'user-123';
  const testSchoolId = 'school-456';
  const testFamilyId = 'family-789';

  beforeEach(() => {
    app = buildApp();
    mockUserDoc = {
      _id: testUserId,
      isActive: true,
      roles: ['admin'],
      schoolId: testSchoolId,
    };
    jest.clearAllMocks();
  });

  it('should reject refresh when user is deactivated', async () => {
    const refreshToken = 'test-refresh-token-123';
    const meta = {
      familyId: testFamilyId,
      sessionId: 'session-123',
      userId: testUserId,
      role: 'admin',
      roles: ['admin'],
      schoolId: testSchoolId,
      issuedAt: Math.floor(Date.now() / 1000),
    };

    // Store the token in memory (simulating Redis)
    const store = authController._getTokenStore();
    if (store && store.setToken) {
      await store.setToken(refreshToken, 86400, meta);
    }

    // Deactivate the user
    mockUserDoc.isActive = false;

    const res = await request(app)
      .post('/refresh')
      .send({ refreshToken })
      .expect(401);

    expect(res.body.code).toBe('ACCOUNT_DISABLED');
  });

  it('should reject refresh when user does not exist', async () => {
    const refreshToken = 'test-refresh-token-456';
    const meta = {
      familyId: testFamilyId,
      sessionId: 'session-456',
      userId: 'nonexistent-user',
      role: 'admin',
      roles: ['admin'],
      schoolId: testSchoolId,
      issuedAt: Math.floor(Date.now() / 1000),
    };

    const store = authController._getTokenStore();
    if (store && store.setToken) {
      await store.setToken(refreshToken, 86400, meta);
    }

    const res = await request(app)
      .post('/refresh')
      .send({ refreshToken })
      .expect(401);

    expect(res.body.code).toBe('ACCOUNT_DISABLED');
  });

  it('should reflect role changes in the refreshed access token', async () => {
    const refreshToken = 'test-refresh-token-789';
    const meta = {
      familyId: testFamilyId,
      sessionId: 'session-789',
      userId: testUserId,
      role: 'admin',
      roles: ['admin'],
      schoolId: testSchoolId,
      issuedAt: Math.floor(Date.now() / 1000),
    };

    const store = authController._getTokenStore();
    if (store && store.setToken) {
      await store.setToken(refreshToken, 86400, meta);
    }

    // Change user roles
    mockUserDoc.roles = ['read_only'];

    const res = await request(app)
      .post('/refresh')
      .send({ refreshToken })
      .expect(200);

    const { accessToken } = res.body;
    const decoded = jwt.decode(accessToken, { complete: true });

    // Verify that the new token reflects the current roles
    expect(decoded.payload.roles).toEqual(['read_only']);
  });

  it('should reflect school changes in the refreshed access token', async () => {
    const refreshToken = 'test-refresh-token-school';
    const meta = {
      familyId: testFamilyId,
      sessionId: 'session-school',
      userId: testUserId,
      role: 'admin',
      roles: ['admin'],
      schoolId: testSchoolId,
      issuedAt: Math.floor(Date.now() / 1000),
    };

    const store = authController._getTokenStore();
    if (store && store.setToken) {
      await store.setToken(refreshToken, 86400, meta);
    }

    // Change user school
    const newSchoolId = 'school-999';
    mockUserDoc.schoolId = newSchoolId;

    const res = await request(app)
      .post('/refresh')
      .send({ refreshToken })
      .expect(200);

    const { accessToken } = res.body;
    const decoded = jwt.decode(accessToken, { complete: true });

    // Verify that the new token reflects the current schoolId
    expect(decoded.payload.schoolId).toBe(newSchoolId);
  });

  it('should enforce absolute session maximum lifetime', async () => {
    const refreshToken = 'test-refresh-token-maxage';
    const oldTimestamp = Math.floor(Date.now() / 1000) - (31 * 24 * 3600); // 31 days old

    const meta = {
      familyId: testFamilyId,
      sessionId: 'session-maxage',
      userId: testUserId,
      role: 'admin',
      roles: ['admin'],
      schoolId: testSchoolId,
      issuedAt: oldTimestamp,
      sessionMaxAge: oldTimestamp + (30 * 24 * 3600), // max age of 30 days
    };

    const store = authController._getTokenStore();
    if (store && store.setToken) {
      await store.setToken(refreshToken, 86400, meta);
    }

    const res = await request(app)
      .post('/refresh')
      .send({ refreshToken })
      .expect(401);

    expect(res.body.code).toBe('SESSION_EXPIRED');
  });
});
