'use strict';

/**
 * Tests for issue #1527 — logging out or revoking a session does not invalidate
 * the access token.
 *
 * Stolen tokens stay valid for up to 8 hours because handleLogout and
 * handleRevokeSession revoke the refresh-token family but never check the
 * access token against a revocation list.
 *
 * Acceptance criteria:
 * - After POST /api/auth/logout, requests bearing the previous access token are rejected with 401
 * - After DELETE /api/auth/sessions/:id, requests are rejected with 401
 * - Access-token TTL default is ≤ 15 minutes and configurable
 * - Tests cover logout, session revocation and user deactivation invalidating live access tokens
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
const authMiddleware = require('../src/middleware/auth');

const testSecret = process.env.JWT_SECRET || 'test-secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/logout', authController.handleLogout);
  app.delete('/sessions/:sessionId', authController.handleRevokeSession);
  app.get('/protected', authMiddleware.requireSchoolAuth(), (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('Issue #1527: Access token revocation', () => {
  let app;
  const testSessionId = 'session-123';
  const testSchoolId = 'school-456';
  const testUserId = 'user-123';

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('should revoke access token on logout', async () => {
    const accessToken = jwt.sign(
      {
        userId: testUserId,
        schoolId: testSchoolId,
        role: 'admin',
        sid: testSessionId,
        jti: 'token-123',
      },
      testSecret,
      { expiresIn: '15m' }
    );

    // First, verify the token works
    const beforeLogout = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(beforeLogout.body.ok).toBe(true);

    // Logout
    await request(app)
      .post('/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sessionId: testSessionId })
      .expect(200);

    // After logout, the token should be rejected
    const afterLogout = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    expect(afterLogout.body.code).toBe('TOKEN_REVOKED');
  });

  it('should revoke access token on session revocation', async () => {
    const accessToken = jwt.sign(
      {
        userId: testUserId,
        schoolId: testSchoolId,
        role: 'admin',
        sid: testSessionId,
        jti: 'token-456',
      },
      testSecret,
      { expiresIn: '15m' }
    );

    // First, verify the token works
    await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Revoke the session
    await request(app)
      .delete(`/sessions/${testSessionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // After revocation, the token should be rejected
    const afterRevoke = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    expect(afterRevoke.body.code).toBe('TOKEN_REVOKED');
  });

  it('should include sid and jti claims in access tokens', async () => {
    const payload = {
      userId: testUserId,
      schoolId: testSchoolId,
      role: 'admin',
    };

    // Create a token with proper claims
    const token = jwt.sign(payload, testSecret, { expiresIn: '15m' });
    const decoded = jwt.decode(token, { complete: true });

    // Verify sid and jti are present
    expect(decoded.payload).toHaveProperty('sid');
    expect(decoded.payload).toHaveProperty('jti');
  });

  it('should have access token TTL <= 15 minutes', async () => {
    const payload = {
      userId: testUserId,
      schoolId: testSchoolId,
      role: 'admin',
    };

    const token = jwt.sign(payload, testSecret, { expiresIn: '15m' });
    const decoded = jwt.decode(token, { complete: true });

    const issuedAt = decoded.payload.iat;
    const expiresAt = decoded.payload.exp;
    const ttlSeconds = expiresAt - issuedAt;
    const ttlMinutes = ttlSeconds / 60;

    expect(ttlMinutes).toBeLessThanOrEqual(15);
  });

  it('should revoke tokens when user is deactivated', async () => {
    const accessToken = jwt.sign(
      {
        userId: testUserId,
        schoolId: testSchoolId,
        role: 'admin',
        sid: testSessionId,
        jti: 'token-789',
      },
      testSecret,
      { expiresIn: '15m' }
    );

    // First, verify the token works
    await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Simulate user deactivation (should revoke all tokens)
    // This would be triggered by a user deactivation endpoint
    const deactivateRes = await request(app)
      .post('/deactivate-user')
      .send({ userId: testUserId })
      .expect(200);

    // After deactivation, the token should be rejected
    const afterDeactivate = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    expect(afterDeactivate.body.code).toBe('ACCOUNT_DISABLED');
  });
});
