'use strict';

/**
 * Tests for issue #1940 — access tokens carry the session id (`sid`), so logout,
 * session revocation and password change deny the access token too, not just the
 * refresh family. Before the fix, `decoded.sid && …` skipped the check for every
 * token, so a logged-out access token stayed valid for up to 8 hours.
 */

// Jest workers share process.env across test files; put back what this file changed.
const ORIGINAL_ENV = { ...process.env };
afterAll(() => {
  for (const key of ['NODE_ENV', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'REQUIRE_SESSION_ID']) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'k'.repeat(48);
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-password';

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('../src/config/redisClient', () => ({
  getRedisClient: jest.fn(() => null),
  isRedisReady: jest.fn(() => false),
}));

jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn() }));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));

// The real in-memory cache backs the access-token denylist, so it is not mocked.

const mockUserState = { user: null };
const mockSchoolState = { school: null };

jest.mock('../src/models/userModel', () => {
  const docOf = (value) => (value ? { ...value } : null);
  return {
    findOne: jest.fn(async () => docOf(mockUserState.user)),
    // Serves three call shapes: `await findById(id)` (full doc, used by
    // change-password), `.select().lean()` and `.lean()` (used by the session check).
    findById: jest.fn(() => {
      const doc = docOf(mockUserState.user);
      return Object.assign(Promise.resolve(doc), {
        select: () => ({ lean: async () => docOf(mockUserState.user) }),
        lean: async () => docOf(mockUserState.user),
      });
    }),
    findByIdAndUpdate: jest.fn(async () => null),
  };
});

jest.mock('../src/models/schoolModel', () => ({
  findOne: jest.fn(async () => (mockSchoolState.school ? { ...mockSchoolState.school } : null)),
}));

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const tokenService = require('../src/services/tokenService');
const authRoutes = require('../src/routes/authRoutes');

const DB_USER_ID = '65a000000000000000000002';
const SCHOOL_ID = 'SCH-1940';
const DB_PASSWORD = 'db-user-password';
const SCOPED = { 'X-School-ID': SCHOOL_ID };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  return app;
}

function cookiesFrom(res) {
  const raw = res.headers['set-cookie'] || [];
  const pick = (name) => {
    const hit = raw.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(';')[0] : null;
  };
  return { admin: pick('admin_token'), refresh: pick('admin_refresh_token') };
}

function sidOf(cookie) {
  return tokenService.verify(cookie.split('=')[1]).sid;
}

async function loginSuperAdmin(app) {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'correct-password' });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

async function loginDbUser(app) {
  const res = await request(app).post('/api/auth/login').send({ email: 'owner@school.test', password: DB_PASSWORD });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.REQUIRE_SESSION_ID;
  mockUserState.user = {
    _id: DB_USER_ID,
    email: 'owner@school.test',
    passwordHash: await bcrypt.hash(DB_PASSWORD, 4),
    roles: ['owner'],
    schoolId: SCHOOL_ID,
    isActive: true,
    tokenVersion: 0,
    mfaEnabled: false,
    mfaSecret: null,
  };
  mockSchoolState.school = { schoolId: SCHOOL_ID, isActive: true, requireMfa: false };
});

describe('issue #1940 — access tokens are bound to their session', () => {
  test('a login issues an access token whose sid is the refresh session id', async () => {
    const app = buildApp();
    const first = await loginSuperAdmin(app);
    const sessions = await request(app).get('/api/auth/sessions').set('Cookie', first.admin);
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions.map((s) => s.sessionId)).toContain(sidOf(first.admin));
  });

  test('logout (with refresh cookie) denies the access token immediately', async () => {
    const app = buildApp();
    const first = await loginSuperAdmin(app);
    expect((await request(app).get('/api/auth/me').set('Cookie', first.admin)).status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set('Cookie', `${first.admin}; ${first.refresh}`);
    expect(out.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set('Cookie', first.admin);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_REVOKED');
  });

  test('logout with only the access cookie still denies that session', async () => {
    const app = buildApp();
    const first = await loginSuperAdmin(app);

    await request(app).post('/api/auth/logout').set('Cookie', first.admin);

    const after = await request(app).get('/api/auth/me').set('Cookie', first.admin);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_REVOKED');
  });

  test('revoking one session via DELETE /sessions/:id kills that device only', async () => {
    const app = buildApp();
    const deviceA = await loginSuperAdmin(app);
    const deviceB = await loginSuperAdmin(app);
    const sidA = sidOf(deviceA.admin);

    const revoke = await request(app).delete(`/api/auth/sessions/${sidA}`).set('Cookie', deviceB.admin);
    expect(revoke.status).toBe(200);

    expect((await request(app).get('/api/auth/me').set('Cookie', deviceA.admin)).body.code).toBe('SESSION_REVOKED');
    expect((await request(app).get('/api/auth/me').set('Cookie', deviceB.admin)).status).toBe(200);
  });

  test('refresh keeps the same sid, so revoking the session also kills the refreshed token', async () => {
    const app = buildApp();
    const first = await loginDbUser(app);
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', first.refresh);
    expect(refreshed.status).toBe(200);
    const second = cookiesFrom(refreshed);
    expect(sidOf(second.admin)).toBe(sidOf(first.admin));

    await request(app).delete(`/api/auth/sessions/${sidOf(second.admin)}`).set(SCOPED).set('Cookie', second.admin);

    const me = await request(app).get('/api/auth/me').set(SCOPED).set('Cookie', second.admin);
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('SESSION_REVOKED');
  });

  test('password change denies every other device on its next request', async () => {
    const app = buildApp();
    const deviceA = await loginDbUser(app);
    const deviceB = await loginDbUser(app);
    expect((await request(app).get('/api/auth/me').set(SCOPED).set('Cookie', deviceB.admin)).status).toBe(200);

    const change = await request(app)
      .post('/api/auth/change-password')
      .set(SCOPED)
      .set('Cookie', deviceA.admin)
      .send({ currentPassword: DB_PASSWORD, newPassword: 'a-new-password-1' });
    expect(change.status).toBe(200);

    const otherDevice = await request(app).get('/api/auth/me').set(SCOPED).set('Cookie', deviceB.admin);
    expect(otherDevice.status).toBe(401);
    expect(otherDevice.body.code).toBe('SESSION_REVOKED');
  });
});

describe('issue #1940 — legacy tokens without a sid', () => {
  // Same derivation as tokenService.getSigningKey, so the token is valid apart from the sid.
  function legacyTokenWithoutSid() {
    const key = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(process.env.JWT_SECRET), Buffer.alloc(0), Buffer.from('access-token'), 32),
    ).toString('hex');
    return jwt.sign(
      { role: 'admin', userId: 'super_admin', roles: ['super_admin'] },
      key,
      { algorithm: 'HS256', expiresIn: 600, issuer: 'stellaredupay-api', audience: 'stellaredupay-admin' },
    );
  }

  test('are accepted by default, so existing sessions survive the upgrade', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/auth/me').set('Cookie', `admin_token=${legacyTokenWithoutSid()}`);
    expect(res.status).toBe(200);
  });

  // Asserted on tokenService directly: a refused HTTP request would count toward the
  // per-IP auth-failure block and leak into later suites that share the process.
  test('are refused by tokenService.verify once REQUIRE_SESSION_ID=true', () => {
    process.env.REQUIRE_SESSION_ID = 'true';
    try {
      expect(() => tokenService.verify(legacyTokenWithoutSid())).toThrow(/session id/);
    } finally {
      delete process.env.REQUIRE_SESSION_ID;
    }
  });
});
