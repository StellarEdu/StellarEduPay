'use strict';

/**
 * Tests for issue #1739 — REQUIRE_MFA enrolment loop
 *
 * Two bugs caused a permanent redirect loop back to /mfa-setup even after
 * an admin completed MFA enrolment:
 *
 *   Bug 1: parseInt("8h") === 8 — the reissued access token expired after
 *          8 *seconds* instead of 8 hours, causing an immediate silent refresh.
 *
 *   Bug 2: handleRefresh copied mfaSetupPending from stored metadata, so
 *          every silent refresh re-minted a restricted token even though the
 *          user had already enrolled.
 *
 * Acceptance criteria (from the issue):
 *   1. After enrolment the access-token TTL equals parseTTL("JWT_ACCESS_TOKEN_TTL").
 *   2. After enrolment the refresh token no longer carries mfaSetupPending.
 *   3. After a simulated expiry+refresh the new access token does NOT contain
 *      mfaSetupPending — the admin reaches a protected route without a loop.
 *   4. JWT_ACCESS_TOKEN_TTL accepts "8h", "30m", and bare seconds consistently.
 */

process.env.JWT_SECRET = 'test-jwt-secret-1739-abcdef1234567890';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.REQUIRE_MFA = 'true';
process.env.JWT_ACCESS_TOKEN_TTL = '8h';
process.env.JWT_REFRESH_TOKEN_TTL = '30d';

// ── Mock infrastructure ───────────────────────────────────────────────────────

jest.mock('../src/utils/logger', () => {
  const l = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  l.child = () => l;
  return l;
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

jest.mock('../src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/schoolCacheInvalidator', () => ({
  invalidate: jest.fn(),
}));

// ── JWT – use the real library so expiresIn is actually encoded ───────────────
// (do NOT mock jsonwebtoken; we need the real TTL in the payload)

// ── Speakeasy mock — always accepts code "123456" with the test secret ────────
jest.mock('speakeasy', () => ({
  generateSecret: jest.fn().mockReturnValue({
    base32: 'JBSWY3DPEBLW64TMMQ======',
    otpauth_url: 'otpauth://totp/test',
  }),
  totp: {
    verify: jest.fn(({ token }) => token === '123456'),
  },
}));

// ── userModel mock ────────────────────────────────────────────────────────────

const mockUserId = 'user-1739';
const mockSchoolId = 'school-1739';

const mockUserBase = {
  _id: mockUserId,
  email: 'mfa-test@school.test',
  passwordHash: '$2a$10$mockedhash',
  schoolId: mockSchoolId,
  roles: ['owner'],
  isActive: true,
  mfaEnabled: false,      // not enrolled yet at login
  mfaSecret: null,
  mfaBackupCodes: [],
  save: jest.fn().mockResolvedValue(true),
  toString: () => mockUserId,
};

// Mutable so tests can flip mfaEnabled after the verify step.
let liveUserState = { ...mockUserBase };

jest.mock('../src/models/userModel', () => ({
  findOne:         jest.fn(async () => ({ ...liveUserState })),
  findById:        jest.fn(async () => ({ ...liveUserState, save: jest.fn().mockResolvedValue(true) })),
  findByIdAndUpdate: jest.fn(async (id, update) => {
    // Simulate the update so subsequent findById calls see mfaEnabled:true
    if (update?.$set?.mfaEnabled !== undefined) {
      liveUserState.mfaEnabled = update.$set.mfaEnabled;
    }
    if (update?.$set?.mfaSecret !== undefined) {
      liveUserState.mfaSecret = update.$set.mfaSecret;
    }
    return { ...liveUserState };
  }),
}));

// ── schoolModel mock — school has requireMfa: true ───────────────────────────

jest.mock('../src/models/schoolModel', () => ({
  findOne: jest.fn().mockResolvedValue({
    _id: 'school-1739',
    schoolId: mockSchoolId,
    slug: 'test-school-1739',
    name: 'Test School 1739',
    requireMfa: true,
    mfaEnabled: false,
    mfaSecret: null,
    mfaBackupCodes: [],
    isActive: true,
    save: jest.fn().mockResolvedValue(true),
  }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

// ── AuditLog mock ─────────────────────────────────────────────────────────────

jest.mock('../src/models/auditLogModel', () => {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    bypassTenantScope: jest.fn().mockResolvedValue(null),
  };
  return {
    create: jest.fn().mockResolvedValue({ _id: 'audit-1739' }),
    findOne: jest.fn(() => chain),
  };
});

// ── bcryptjs mock ─────────────────────────────────────────────────────────────

jest.mock('bcryptjs', () => ({
  compare:  jest.fn().mockResolvedValue(true),
  hash:     jest.fn().mockResolvedValue('$2a$10$mockedhash'),
  genSalt:  jest.fn().mockResolvedValue('salt'),
}));

// ── Import SUT after mocks are in place ──────────────────────────────────────

const jwt = require('jsonwebtoken');
const authController = require('../src/controllers/authController');
const mfaController  = require('../src/controllers/mfaController');
const { parseTTL }   = authController;

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockRes() {
  const cookies = {};
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn((name, value) => { cookies[name] = value; return res; });
  res.clearCookie = jest.fn().mockReturnValue(res);
  res._cookies = cookies;
  return res;
}

function mockLoginReq(body = {}) {
  return {
    body,
    cookies: {},
    headers: {},
    ip: '127.0.0.1',
    connection: {},
  };
}

function mockMfaReq(user, cookies = {}) {
  return {
    user,
    body: {},
    cookies,
    headers: {},
    ip: '127.0.0.1',
    connection: {},
    auditContext: { performedBy: user?.email },
  };
}

function decodeToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #1739: REQUIRE_MFA enrolment loop', () => {
  beforeEach(() => {
    // Reset live user state to "not enrolled" for each test
    liveUserState = {
      ...mockUserBase,
      mfaEnabled: false,
      mfaSecret: null,
      save: jest.fn().mockResolvedValue(true),
    };
    authController._resetStore();
    jest.clearAllMocks();
  });

  // ── Acceptance criterion 4: parseTTL handles unit suffixes ─────────────────

  describe('parseTTL — unit suffix support (acceptance criterion 4)', () => {
    it('correctly parses "8h" to 28800 seconds', () => {
      process.env.JWT_ACCESS_TOKEN_TTL = '8h';
      expect(parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600)).toBe(28800);
    });

    it('correctly parses "30m" to 1800 seconds', () => {
      process.env.JWT_ACCESS_TOKEN_TTL = '30m';
      expect(parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600)).toBe(1800);
      process.env.JWT_ACCESS_TOKEN_TTL = '8h'; // restore
    });

    it('correctly parses "3600" (bare number) to 3600 seconds', () => {
      process.env.JWT_ACCESS_TOKEN_TTL = '3600';
      expect(parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600)).toBe(3600);
      process.env.JWT_ACCESS_TOKEN_TTL = '8h'; // restore
    });

    it('parseInt("8h") would have returned 8 — the original bug', () => {
      // Demonstrate the old broken behaviour so the regression is explicit.
      expect(parseInt('8h', 10)).toBe(8);
    });
  });

  // ── Acceptance criterion 1: reissued token has correct TTL ─────────────────

  describe('verifyAndEnableUserMfa — access-token TTL (acceptance criterion 1)', () => {
    it('sets maxAge on the reissued cookie using parseTTL, not parseInt', async () => {
      process.env.JWT_ACCESS_TOKEN_TTL = '8h';

      // User is in the mfaSetupPending state (restricted token from login).
      const req = mockMfaReq(
        { userId: mockUserId, schoolId: mockSchoolId, role: 'user', roles: ['owner'], mfaSetupPending: true },
        { admin_refresh_token: 'old-restricted-refresh-token' }
      );
      req.body = { secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' };
      const res = mockRes();

      // Pre-populate the old restricted refresh token in the store.
      const store = authController.getStore();
      await store.setToken('old-restricted-refresh-token', 86400, {
        familyId: 'family-old-1739',
        sessionId: 'sess-old-1739',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      await mfaController.verifyAndEnableUserMfa(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/MFA enabled/i) }));
      expect(res.cookie).toHaveBeenCalled();

      // The admin_token cookie must have maxAge = 28800 * 1000 ms (8h), NOT 8000 ms (8s).
      const adminTokenCall = res.cookie.mock.calls.find(([name]) => name === 'admin_token');
      expect(adminTokenCall).toBeDefined();
      const opts = adminTokenCall[2];
      expect(opts.maxAge).toBe(28800 * 1000); // 8h in ms
    });

    it('the reissued access token must not carry mfaSetupPending', async () => {
      process.env.JWT_ACCESS_TOKEN_TTL = '8h';

      const req = mockMfaReq(
        { userId: mockUserId, schoolId: mockSchoolId, role: 'user', roles: ['owner'], mfaSetupPending: true },
        { admin_refresh_token: 'old-rt-no-flag' }
      );
      req.body = { secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' };
      const res = mockRes();

      const store = authController.getStore();
      await store.setToken('old-rt-no-flag', 86400, {
        familyId: 'family-no-flag',
        sessionId: 'sess-no-flag',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      await mfaController.verifyAndEnableUserMfa(req, res);

      const tokenCall = res.cookie.mock.calls.find(([name]) => name === 'admin_token');
      expect(tokenCall).toBeDefined();
      const newAccessToken = tokenCall[1];
      const decoded = decodeToken(newAccessToken);
      expect(decoded.mfaSetupPending).toBeUndefined();
    });
  });

  // ── Acceptance criterion 2: refresh token rotation (acceptance criterion 2) ──

  describe('verifyAndEnableUserMfa — refresh-token rotation (acceptance criterion 2)', () => {
    it('revokes the old restricted refresh-token family', async () => {
      const oldFamilyId = 'family-restricted-1739';
      const store = authController.getStore();
      await store.setToken('old-rt-rotation', 86400, {
        familyId: oldFamilyId,
        sessionId: 'sess-rotation',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      const req = mockMfaReq(
        { userId: mockUserId, schoolId: mockSchoolId, role: 'user', roles: ['owner'], mfaSetupPending: true },
        { admin_refresh_token: 'old-rt-rotation' }
      );
      req.body = { secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' };
      const res = mockRes();

      await mfaController.verifyAndEnableUserMfa(req, res);

      // The old token must be gone from the store.
      const oldMeta = await store.getToken('old-rt-rotation');
      expect(oldMeta).toBeNull();

      // The old family must be revoked so any copy of the token is dead.
      const isRevoked = await store.isFamilyRevoked(oldFamilyId);
      expect(isRevoked).toBe(true);
    });

    it('issues a new refresh token whose metadata does not have mfaSetupPending', async () => {
      const store = authController.getStore();
      await store.setToken('old-rt-new-meta', 86400, {
        familyId: 'family-new-meta',
        sessionId: 'sess-new-meta',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      const req = mockMfaReq(
        { userId: mockUserId, schoolId: mockSchoolId, role: 'user', roles: ['owner'], mfaSetupPending: true },
        { admin_refresh_token: 'old-rt-new-meta' }
      );
      req.body = { secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' };
      const res = mockRes();

      await mfaController.verifyAndEnableUserMfa(req, res);

      // Find the new refresh token value from the set-cookie calls.
      const rtCall = res.cookie.mock.calls.find(([name]) => name === 'admin_refresh_token');
      expect(rtCall).toBeDefined();
      const newRefreshTokenValue = rtCall[1];

      // Its stored metadata must not contain mfaSetupPending.
      const newMeta = await store.getToken(newRefreshTokenValue);
      expect(newMeta).not.toBeNull();
      expect(newMeta.mfaSetupPending).toBeUndefined();
    });
  });

  // ── Acceptance criterion 3: full loop — login → setup → verify → refresh ───

  describe('Full enrolment loop (acceptance criterion 3)', () => {
    it('login → MFA enrolment → refresh: refreshed token has no mfaSetupPending', async () => {
      // Step 1 — Login as a user without MFA on a school that requires it.
      // The login handler issues a restricted access token (mfaSetupPending:true).
      const loginReq  = mockLoginReq({ email: 'mfa-test@school.test', password: 'password' });
      const loginRes  = mockRes();
      await authController.handleLogin(loginReq, loginRes);

      expect(loginRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ mfaSetupRequired: true })
      );

      const loginAccessToken = loginRes._cookies['admin_token'];
      expect(loginAccessToken).toBeDefined();
      const loginDecoded = decodeToken(loginAccessToken);
      expect(loginDecoded.mfaSetupPending).toBe(true);

      const loginRefreshToken = loginRes._cookies['admin_refresh_token'];
      expect(loginRefreshToken).toBeDefined();

      // Step 2 — Complete MFA enrolment via /mfa/user/verify.
      // The request carries a restricted mfaSetupPending token and the old
      // refresh token in its cookies.
      const verifyReq = mockMfaReq(
        { userId: mockUserId, schoolId: mockSchoolId, role: 'user', roles: ['owner'], mfaSetupPending: true },
        { admin_refresh_token: loginRefreshToken }
      );
      verifyReq.body = { secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' };
      const verifyRes = mockRes();

      // Simulate the DB update: mfaEnabled flips to true inside findByIdAndUpdate mock.
      await mfaController.verifyAndEnableUserMfa(verifyReq, verifyRes);

      expect(verifyRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/MFA enabled/i) })
      );

      // The reissued access token must not be restricted.
      const newAccessToken = verifyRes._cookies['admin_token'];
      expect(newAccessToken).toBeDefined();
      const newDecoded = decodeToken(newAccessToken);
      expect(newDecoded.mfaSetupPending).toBeUndefined();

      // A clean refresh token must have been issued.
      const newRefreshToken = verifyRes._cookies['admin_refresh_token'];
      expect(newRefreshToken).toBeDefined();
      expect(newRefreshToken).not.toBe(loginRefreshToken);

      // Step 3 — Simulate the access token "expiring" and the frontend running a
      // silent refresh. Use the new clean refresh token.
      // The live user now has mfaEnabled:true, so mfaSetupPending must be false.
      const refreshReq = {
        cookies: { admin_refresh_token: newRefreshToken },
        body: {},
        ip: '127.0.0.1',
        connection: {},
      };
      const refreshRes = mockRes();
      await authController.handleRefresh(refreshReq, refreshRes);

      expect(refreshRes.status).not.toHaveBeenCalledWith(401);
      expect(refreshRes.status).not.toHaveBeenCalledWith(403);

      const refreshedAccessToken = refreshRes._cookies['admin_token'];
      expect(refreshedAccessToken).toBeDefined();
      const refreshedDecoded = decodeToken(refreshedAccessToken);

      // This is the core acceptance criterion: the refreshed token must NOT
      // carry mfaSetupPending. Before the fix it would because handleRefresh
      // copied the flag from the stored metadata.
      expect(refreshedDecoded.mfaSetupPending).toBeUndefined();
    });

    it('after enrolment, re-using the OLD restricted refresh token is rejected (family revoked)', async () => {
      // Simulate having a refresh token whose family we revoked during enrolment.
      const store = authController.getStore();
      const oldFamilyId = 'family-old-restricted-loop';
      await store.setToken('old-rt-loop', 86400, {
        familyId: oldFamilyId,
        sessionId: 'sess-old-loop',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      // Enrolment — revokes the family.
      const verifyReq = mockMfaReq(
        { userId: mockUserId, schoolId: mockSchoolId, role: 'user', roles: ['owner'], mfaSetupPending: true },
        { admin_refresh_token: 'old-rt-loop' }
      );
      verifyReq.body = { secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' };
      const verifyRes = mockRes();
      await mfaController.verifyAndEnableUserMfa(verifyReq, verifyRes);

      // Now try to use a copy of the old token (e.g. from another tab).
      // It must be rejected because the family is revoked.
      const refreshReq = {
        cookies: { admin_refresh_token: 'old-rt-loop' },
        body: {},
        ip: '127.0.0.1',
        connection: {},
      };
      const refreshRes = mockRes();
      await authController.handleRefresh(refreshReq, refreshRes);

      expect(refreshRes.status).toHaveBeenCalledWith(401);
    });
  });

  // ── handleRefresh live-user lookup ────────────────────────────────────────

  describe('handleRefresh — live mfaSetupPending re-derivation', () => {
    it('does NOT copy mfaSetupPending into the new token when user is now enrolled', async () => {
      // Store a refresh token that was issued with mfaSetupPending:true (old loop state).
      const store = authController.getStore();
      const refreshToken = 'rt-was-pending';
      await store.setToken(refreshToken, 86400, {
        familyId: 'fam-was-pending',
        sessionId: 'sess-was-pending',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      // At this point the live user record shows mfaEnabled:true (enrolled).
      liveUserState.mfaEnabled = true;
      liveUserState.mfaSecret  = 'encrypted-secret-value';

      const req = {
        cookies: { admin_refresh_token: refreshToken },
        body: {},
        ip: '127.0.0.1',
        connection: {},
      };
      const res = mockRes();
      await authController.handleRefresh(req, res);

      expect(res.status).not.toHaveBeenCalledWith(401);

      const newAccessToken = res._cookies['admin_token'];
      expect(newAccessToken).toBeDefined();
      const decoded = decodeToken(newAccessToken);
      expect(decoded.mfaSetupPending).toBeUndefined();
    });

    it('DOES set mfaSetupPending on the new token when user is still not enrolled', async () => {
      // User has not yet enrolled — mfaEnabled remains false.
      liveUserState.mfaEnabled = false;
      liveUserState.mfaSecret  = null;

      const store = authController.getStore();
      const refreshToken = 'rt-still-pending';
      await store.setToken(refreshToken, 86400, {
        familyId: 'fam-still-pending',
        sessionId: 'sess-still-pending',
        userId: mockUserId,
        role: 'user',
        roles: ['owner'],
        schoolId: mockSchoolId,
        mfaSetupPending: true,
      });

      const req = {
        cookies: { admin_refresh_token: refreshToken },
        body: {},
        ip: '127.0.0.1',
        connection: {},
      };
      const res = mockRes();
      await authController.handleRefresh(req, res);

      expect(res.status).not.toHaveBeenCalledWith(401);

      const newAccessToken = res._cookies['admin_token'];
      expect(newAccessToken).toBeDefined();
      const decoded = decodeToken(newAccessToken);
      // Still unenrolled → flag must be present.
      expect(decoded.mfaSetupPending).toBe(true);
    });
  });
});
