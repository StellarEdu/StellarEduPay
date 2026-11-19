'use strict';

/**
 * Tenant binding through a single verification path (#1941).
 *
 * resolveSchool used to verify tokens with the raw JWT_SECRET and swallow every
 * error, so tenant binding and the super-admin audit silently never ran once
 * access tokens were signed with the HKDF key. These tests exercise the real
 * middleware chain (resolveSchool -> requireSchoolAuth) against tokens minted
 * by tokenService, and check that:
 *   1. A valid school-A token cannot reach school B on any route, including
 *      routes that only run resolveSchool (no requireSchoolAuth).
 *   2. A token that fails verification is never trusted for tenant binding.
 *   3. Super-admin cross-tenant use is audited.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'issue1941-test-secret-value-32-bytes!!';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/models/schoolModel', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/userModel', () => ({ findById: jest.fn() }));

const School = require('../src/models/schoolModel');
const User = require('../src/models/userModel');
const tokenService = require('../src/services/tokenService');
const { logAudit } = require('../src/services/auditService');
const { resolveSchool } = require('../src/middleware/schoolContext');
const { requireSchoolAuth } = require('../src/middleware/auth');

const SCHOOL_A = { _id: '507f1f77bcf86cd799439011', schoolId: 'SCH-1941-A', slug: 'a-1941', isActive: true, maintenanceMode: false };
const SCHOOL_B = { _id: '507f1f77bcf86cd799439012', schoolId: 'SCH-1941-B', slug: 'b-1941', isActive: true, maintenanceMode: false };
const SCHOOLS = { [SCHOOL_A.schoolId]: SCHOOL_A, [SCHOOL_B.schoolId]: SCHOOL_B };

function buildApp() {
  const app = express();
  app.use(express.json());
  // Public-style route: tenant resolution only, no auth middleware.
  app.get('/public/intent', resolveSchool, (req, res) => res.json({ ok: true, schoolId: req.schoolId }));
  // Protected route: tenant resolution plus the school auth middleware.
  app.get('/api/students', resolveSchool, requireSchoolAuth(['owner', 'staff']), (req, res) =>
    res.json({ ok: true, schoolId: req.schoolId })
  );
  return app;
}

function ownerToken(schoolId, extra = {}) {
  return tokenService.sign({
    role: 'user',
    userId: 'user-1941',
    schoolId,
    roles: ['owner'],
    tokenVersion: 0,
    ...extra,
  }).token;
}

describe('Tenant binding uses the single token verification path (#1941)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    School.findOne.mockImplementation((query) => ({
      lean: jest.fn().mockResolvedValue(SCHOOLS[query.schoolId] || null),
    }));
    User.findById.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ isActive: true, tokenVersion: 0 }) }),
    });
    app = buildApp();
  });

  it('rejects a school-A token sent with X-School-ID B on a protected route', async () => {
    const res = await request(app)
      .get('/api/students')
      .set('X-School-ID', SCHOOL_B.schoolId)
      .set('Authorization', `Bearer ${ownerToken(SCHOOL_A.schoolId)}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_MISMATCH');
  });

  it('rejects a school-A token sent with X-School-ID B on a resolveSchool-only route', async () => {
    const res = await request(app)
      .get('/public/intent')
      .set('X-School-ID', SCHOOL_B.schoolId)
      .set('Authorization', `Bearer ${ownerToken(SCHOOL_A.schoolId)}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_MISMATCH');
  });

  it('allows a school-A token against school A', async () => {
    const res = await request(app)
      .get('/api/students')
      .set('X-School-ID', SCHOOL_A.schoolId)
      .set('Authorization', `Bearer ${ownerToken(SCHOOL_A.schoolId)}`);

    expect(res.status).toBe(200);
    expect(res.body.schoolId).toBe(SCHOOL_A.schoolId);
  });

  it('does not trust a token signed with the raw JWT_SECRET (legacy scheme)', async () => {
    const legacy = jwt.sign({ role: 'user', userId: 'u', schoolId: SCHOOL_A.schoolId, roles: ['owner'] }, process.env.JWT_SECRET);

    // resolveSchool must ignore it (no TENANT_MISMATCH from an unverified claim)...
    const publicRes = await request(app)
      .get('/public/intent')
      .set('X-School-ID', SCHOOL_B.schoolId)
      .set('Authorization', `Bearer ${legacy}`);
    expect(publicRes.status).toBe(200);

    // ...and the protected route must reject it outright.
    const protectedRes = await request(app)
      .get('/api/students')
      .set('X-School-ID', SCHOOL_A.schoolId)
      .set('Authorization', `Bearer ${legacy}`);
    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body.code).toBe('INVALID_AUTH_TOKEN');
  });

  it('audits a super-admin cross-tenant access', async () => {
    const superToken = tokenService.sign({
      role: 'admin',
      username: 'ops@platform.test',
      userId: 'super_admin',
      roles: ['super_admin'],
    }).token;

    const res = await request(app)
      .get('/public/intent')
      .set('X-School-ID', SCHOOL_B.schoolId)
      .set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'super_admin_school_override',
      schoolId: SCHOOL_B.schoolId,
    });
  });
});
