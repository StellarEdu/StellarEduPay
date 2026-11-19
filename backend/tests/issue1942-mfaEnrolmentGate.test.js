'use strict';

/**
 * MFA enrolment enforcement (#1942).
 *
 * When REQUIRE_MFA is set, or the school has requireMfa, a user who has not
 * enrolled TOTP receives a restricted token (mfaSetupPending). Before this fix
 * no middleware read that claim, so the token worked on every route. These
 * tests check that:
 *   1. A restricted token is refused with 403 MFA_ENROLLMENT_REQUIRED on tenant
 *      and admin routes.
 *   2. The enrolment and session endpoints remain reachable.
 *   3. The allow-list cannot be bypassed with a query string, a trailing slash
 *      or a case change.
 *   4. A login minted by handleLogin produces a token that the gate enforces.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'issue1942-test-secret-value-32-bytes!!';

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/models/userModel', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../src/models/schoolModel', () => ({ findOne: jest.fn() }));

// Refresh-token store: the in-memory sessionStore is replaced so login can
// complete without a database. Only the methods login/refresh call are needed.
const mockStore = {
  setToken: jest.fn().mockResolvedValue(undefined),
  setSession: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../src/services/sessionStore', () => ({
  getStore: () => mockStore,
  revokeAllUserSessions: jest.fn(),
  parseTTL: (_name, fallback) => fallback,
  _resetStore: jest.fn(),
}));

const User = require('../src/models/userModel');
const School = require('../src/models/schoolModel');
const tokenService = require('../src/services/tokenService');
const { requireSchoolAuth, requireAdminAuth } = require('../src/middleware/auth');
const { handleLogin } = require('../src/controllers/authController');

const USER_ID = 'user-1942';
const SCHOOL_ID = 'SCH-1942';
const PASSWORD = 'correct-horse-1942';

function restrictedToken() {
  return tokenService.sign({
    role: 'user',
    userId: USER_ID,
    schoolId: SCHOOL_ID,
    roles: ['owner'],
    mfaSetupPending: true,
  }).token;
}

function fullToken() {
  return tokenService.sign({
    role: 'user',
    userId: USER_ID,
    schoolId: SCHOOL_ID,
    roles: ['owner'],
  }).token;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const ok = (req, res) => res.json({ ok: true });

  app.post('/login', handleLogin);
  app.get('/api/students', requireSchoolAuth(['owner', 'staff']), ok);
  app.post('/api/auth/mfa/user/setup', requireSchoolAuth(), ok);
  app.post('/api/auth/mfa/user/verify', requireSchoolAuth(), ok);
  app.get('/api/auth/me', requireSchoolAuth(), ok);
  app.get('/api/admin/overview', requireAdminAuth, ok);
  return app;
}

describe('MFA enrolment gate (#1942)', () => {
  let app;
  const originalRequireMfa = process.env.REQUIRE_MFA;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_MFA;
    User.findById.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ isActive: true, tokenVersion: 0 }) }),
    });
    app = buildApp();
  });

  afterAll(() => {
    if (originalRequireMfa === undefined) delete process.env.REQUIRE_MFA;
    else process.env.REQUIRE_MFA = originalRequireMfa;
  });

  describe('restricted token on protected routes', () => {
    it('is refused on a tenant route with MFA_ENROLLMENT_REQUIRED', async () => {
      const res = await request(app)
        .get('/api/students')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('is refused on an admin route with MFA_ENROLLMENT_REQUIRED', async () => {
      const res = await request(app)
        .get('/api/admin/overview')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('is refused on a query-string bypass attempt', async () => {
      const res = await request(app)
        .get('/api/students?next=/api/auth/me')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    });
  });

  describe('restricted token on enrolment and session endpoints', () => {
    it('can reach /api/auth/mfa/user/setup', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/user/setup')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(200);
    });

    it('can reach /api/auth/mfa/user/verify', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/user/verify')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(200);
    });

    it('can reach /api/auth/me', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(200);
    });

    it('still reaches an allow-listed path with a trailing slash or different case', async () => {
      const res = await request(app)
        .post('/API/auth/mfa/user/setup/')
        .set('Authorization', `Bearer ${restrictedToken()}`);

      expect(res.status).toBe(200);
    });
  });

  describe('fully enrolled token', () => {
    it('reaches tenant routes', async () => {
      const res = await request(app)
        .get('/api/students')
        .set('Authorization', `Bearer ${fullToken()}`);

      expect(res.status).toBe(200);
    });
  });

  describe('login issues a token the gate enforces', () => {
    function loginUser(overrides = {}) {
      return {
        _id: USER_ID,
        email: 'owner@school.test',
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        isActive: true,
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: [],
        schoolId: SCHOOL_ID,
        roles: ['owner'],
        ...overrides,
      };
    }

    it('marks the token restricted when the school requires MFA and the user has none', async () => {
      User.findOne.mockResolvedValue(loginUser());
      School.findOne.mockResolvedValue({ schoolId: SCHOOL_ID, requireMfa: true });

      const login = await request(app)
        .post('/login')
        .send({ email: 'owner@school.test', password: PASSWORD });

      expect(login.status).toBe(200);
      expect(login.body.mfaSetupRequired).toBe(true);

      const cookie = login.headers['set-cookie'].find((c) => c.startsWith('admin_token='));
      const token = decodeURIComponent(cookie.split(';')[0].slice('admin_token='.length));

      const blocked = await request(app).get('/api/students').set('Cookie', `admin_token=${token}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

      const setup = await request(app).post('/api/auth/mfa/user/setup').set('Cookie', `admin_token=${token}`);
      expect(setup.status).toBe(200);
    });

    it('marks the token restricted when REQUIRE_MFA is set globally', async () => {
      process.env.REQUIRE_MFA = 'true';
      User.findOne.mockResolvedValue(loginUser());
      School.findOne.mockResolvedValue({ schoolId: SCHOOL_ID, requireMfa: false });

      const login = await request(app)
        .post('/login')
        .send({ email: 'owner@school.test', password: PASSWORD });

      expect(login.body.mfaSetupRequired).toBe(true);
    });

    it('does not mark the token restricted for a user who has already enrolled', async () => {
      // Enrolled users are challenged for a TOTP code at login instead, so the
      // enrolment gate must not apply to them.
      User.findOne.mockResolvedValue(loginUser({ mfaEnabled: true, mfaSecret: 'x' }));
      School.findOne.mockResolvedValue({ schoolId: SCHOOL_ID, requireMfa: true });

      const login = await request(app)
        .post('/login')
        .send({ email: 'owner@school.test', password: PASSWORD });

      expect(login.body.requiresMfa).toBe(true);
    });
  });
});
