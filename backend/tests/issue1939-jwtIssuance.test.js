'use strict';

/**
 * Tests for issue #1939 — every access token the server issues must be one the
 * auth middleware accepts. Before the fix, login/refresh signed with the raw
 * JWT_SECRET (no iss/aud, no HKDF key), so /auth/me returned 401 right after login.
 *
 * Flow covered for the env super-admin and for a DB user:
 *   login → /auth/me → refresh → /auth/me
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
process.env.JWT_SECRET = 'j'.repeat(48);
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

jest.mock('../src/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));

jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn() }));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));

// DB user fixture. The mocks read this object so each test can adjust it.
const mockUserState = { user: null };
const mockSchoolState = { school: null };

jest.mock('../src/models/userModel', () => {
  const lean = (value) => ({ lean: async () => (value ? { ...value } : null) });
  const selectable = (value) => ({
    select: () => lean(value),
    lean: async () => (value ? { ...value } : null),
  });
  return {
    findOne: jest.fn(async () => (mockUserState.user ? { ...mockUserState.user } : null)),
    findById: jest.fn((id) => selectable(mockUserState.user && String(mockUserState.user._id) === String(id) ? mockUserState.user : null)),
    findByIdAndUpdate: jest.fn(async () => null),
  };
});

jest.mock('../src/models/schoolModel', () => ({
  findOne: jest.fn(async () => (mockSchoolState.school ? { ...mockSchoolState.school } : null)),
}));

const bcrypt = require('bcryptjs');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const tokenService = require('../src/services/tokenService');
const authRoutes = require('../src/routes/authRoutes');

const DB_USER_ID = '65a000000000000000000001';
const SCHOOL_ID = 'SCH-1939';
const DB_PASSWORD = 'db-user-password';

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

function cookieHeader(...parts) {
  return parts.filter(Boolean).join('; ');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserState.user = null;
  mockSchoolState.school = null;
});

describe('issue #1939 — env super-admin: login → /auth/me → refresh → /auth/me', () => {
  test('every step succeeds and the issued token is verifiable by tokenService', async () => {
    const app = buildApp();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct-password' });
    expect(login.status).toBe(200);
    const first = cookiesFrom(login);
    expect(first.admin).toBeTruthy();
    expect(first.refresh).toBeTruthy();

    const adminToken = first.admin.split('=')[1];
    expect(tokenService.verify(adminToken)).toMatchObject({ role: 'admin', userId: 'super_admin' });

    const me1 = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(first.admin));
    expect(me1.status).toBe(200);
    expect(me1.body.roles).toEqual(['super_admin']);

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookieHeader(first.refresh));
    expect(refreshed.status).toBe(200);
    const second = cookiesFrom(refreshed);
    expect(second.admin).toBeTruthy();

    const me2 = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(second.admin));
    expect(me2.status).toBe(200);
    expect(me2.body.userId).toBe('super_admin');
  });

  test('a token signed with the raw JWT_SECRET is rejected, not silently accepted', async () => {
    const app = buildApp();
    const legacy = jwt.sign({ role: 'admin', userId: 'super_admin', roles: ['super_admin'] }, process.env.JWT_SECRET, { expiresIn: 600 });
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(`admin_token=${legacy}`));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_TOKEN');
  });
});

describe('issue #1939 — DB user: login → /auth/me → refresh → /auth/me', () => {
  beforeEach(async () => {
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

  test('every step succeeds for a school-scoped user', async () => {
    const app = buildApp();
    const scoped = { 'X-School-ID': SCHOOL_ID };

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@school.test', password: DB_PASSWORD });
    expect(login.status).toBe(200);
    const first = cookiesFrom(login);

    const me1 = await request(app).get('/api/auth/me').set(scoped).set('Cookie', cookieHeader(first.admin));
    expect(me1.status).toBe(200);
    expect(me1.body).toMatchObject({ userId: DB_USER_ID, schoolId: SCHOOL_ID, roles: ['owner'] });

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookieHeader(first.refresh));
    expect(refreshed.status).toBe(200);
    const second = cookiesFrom(refreshed);

    const me2 = await request(app).get('/api/auth/me').set(scoped).set('Cookie', cookieHeader(second.admin));
    expect(me2.status).toBe(200);
    expect(me2.body.userId).toBe(DB_USER_ID);
  });

  test('a login after a tokenVersion bump still works (the new token carries the current version)', async () => {
    mockUserState.user.tokenVersion = 3;
    const app = buildApp();
    const scoped = { 'X-School-ID': SCHOOL_ID };

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@school.test', password: DB_PASSWORD });
    const admin = cookiesFrom(login).admin;

    const me = await request(app).get('/api/auth/me').set(scoped).set('Cookie', cookieHeader(admin));
    expect(me.status).toBe(200);
  });
});
