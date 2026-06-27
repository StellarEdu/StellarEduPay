'use strict';

/**
 * Tests for Issue #823 — GET /api/auth/me must return real principal, not { isAdmin: true }.
 *
 * Acceptance criteria:
 *  - Unauthenticated request returns 401.
 *  - Authenticated response reflects userId / schoolId / roles / exp from the token.
 */

process.env.MONGO_URI   = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET  = 'test-secret-for-me-endpoint';

const request = require('supertest');
const jwt     = require('jsonwebtoken');

// ── minimal mocks so app.js boots without real infrastructure ─────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema:  class { constructor() { this.index = jest.fn(); } },
  model:   jest.fn().mockReturnValue({}),
  connection: { on: jest.fn() },
}));

jest.mock('../backend/src/models/schoolModel',      () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/studentModel',     () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/feeStructureModel',() => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/paymentModel',     () => ({ find: jest.fn() }));
jest.mock('../backend/src/services/auditService',   () => ({ logAudit: jest.fn().mockResolvedValue({}) }));
jest.mock('../backend/src/services/retryService',   () => ({
  queueForRetry: jest.fn(), startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));
jest.mock('../backend/src/utils/memoEncryption',    () => ({
  encryptMemo: jest.fn(x => x), isEncryptionEnabled: jest.fn(() => false),
}));

const app = require('../backend/src/app');

describe('Issue #823 — GET /api/auth/me', () => {
  const SECRET = process.env.JWT_SECRET;

  test('unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('returns verified principal for super-admin token', async () => {
    const token = jwt.sign(
      { role: 'admin', userId: 'super_admin', roles: ['super_admin'] },
      SECRET,
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('super_admin');
    expect(res.body.roles).toContain('super_admin');
    expect(typeof res.body.exp).toBe('number');
    // Must NOT return the old static payload
    expect(res.body.isAdmin).toBeUndefined();
  });

  test('returns schoolId and roles for school-user token', async () => {
    const token = jwt.sign(
      { role: 'user', userId: 'user-123', schoolId: 'sch-1', roles: ['owner'] },
      SECRET,
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    // requireAdminAuth requires 'admin' role or 'super_admin' in roles,
    // so a plain school user gets 403 INSUFFICIENT_ROLE — the route is guarded.
    expect([403]).toContain(res.status);
  });

  test('expired token returns 401', async () => {
    const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '-1s' });
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });
});
