'use strict';

/**
 * Tests for issue #595 — JWT refresh token flow
 */

process.env.JWT_SECRET = 'test-secret-595';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-password';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';

// Minimal JWT stub — signs with a fake sig but encodes payload faithfully
jest.mock('jsonwebtoken', () => {
  const realBase64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return {
    sign: (payload, secret, opts) => {
      const now = Math.floor(Date.now() / 1000);
      const exp = opts && opts.expiresIn
        ? (typeof opts.expiresIn === 'number' ? now + opts.expiresIn : now - 1) // negative string → expired
        : undefined;
      const full = exp !== undefined ? { ...payload, exp } : payload;
      return `${realBase64url({ alg: 'HS256' })}.${realBase64url(full)}.fakesig`;
    },
    verify: (token, secret) => {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[2] !== 'fakesig') {
        const err = new Error('invalid signature');
        err.name = 'JsonWebTokenError';
        throw err;
      }
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        const err = new Error('jwt expired');
        err.name = 'TokenExpiredError';
        throw err;
      }
      return payload;
    },
  };
}, { virtual: true });

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  set: jest.fn().mockResolvedValue('OK'),
  exists: jest.fn().mockResolvedValue(1),
  del: jest.fn().mockResolvedValue(1),
})), { virtual: true });

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const { handleLogin, handleRefresh, handleLogout, _resetStore } = require('../backend/src/controllers/authController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

describe('#595 JWT refresh token flow', () => {
  beforeEach(() => {
    _resetStore();
    delete process.env.REDIS_HOST;
  });

  // ── Login ──────────────────────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('returns accessToken and refreshToken on valid credentials', async () => {
      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct-password' } }, res);

      expect(res.status).not.toHaveBeenCalled();
      const [body] = res.json.mock.calls[0];
      // Both access and refresh tokens are now delivered as HttpOnly cookies
      // (#821), not in the response body.
      expect(body.token).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
      expect(body.isAdmin).toBe(true);
      expect(typeof body.expiresIn).toBe('number');
      expect(typeof body.refreshExpiresIn).toBe('number');
      // Both cookies must have been set.
      expect(res.cookie).toHaveBeenCalledWith('admin_token', expect.any(String), expect.objectContaining({ httpOnly: true }));
      expect(res.cookie).toHaveBeenCalledWith('admin_refresh_token', expect.any(String), expect.objectContaining({ httpOnly: true }));
    });

    it('access token TTL respects JWT_ACCESS_TOKEN_TTL env var', async () => {
      process.env.JWT_ACCESS_TOKEN_TTL = '3600';
      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct-password' } }, res);

      const [body] = res.json.mock.calls[0];
      expect(body.expiresIn).toBe(3600);
      delete process.env.JWT_ACCESS_TOKEN_TTL;
    });

    it('defaults access token TTL to 8 hours (28800s)', async () => {
      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct-password' } }, res);

      const [body] = res.json.mock.calls[0];
      expect(body.expiresIn).toBe(8 * 3600);
    });

    it('returns 401 for wrong credentials', async () => {
      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'wrong' } }, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // ── Refresh ────────────────────────────────────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('issues a new access token for a valid refresh token', async () => {
      const loginRes = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct-password' } }, loginRes);
      // The refresh token is delivered via the admin_refresh_token cookie (#821).
      const refreshCookie = loginRes.cookie.mock.calls.find(c => c[0] === 'admin_refresh_token');
      const refreshToken = refreshCookie[1];

      const refreshRes = mockRes();
      await handleRefresh({ body: { refreshToken } }, refreshRes);

      expect(refreshRes.status).not.toHaveBeenCalled();
      const [body] = refreshRes.json.mock.calls[0];
      // New access token comes back as a cookie; body carries only TTL metadata.
      expect(body.expiresIn).toBeDefined();
      expect(refreshRes.cookie).toHaveBeenCalledWith('admin_token', expect.any(String), expect.objectContaining({ httpOnly: true }));
    });

    it('returns 401 for an unknown refresh token', async () => {
      const res = mockRes();
      await handleRefresh({ body: { refreshToken: 'not-a-real-token' } }, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_REFRESH_TOKEN' }));
    });

    it('returns 401 when refreshToken is missing', async () => {
      const res = mockRes();
      await handleRefresh({ body: {} }, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_REFRESH_TOKEN' }));
    });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('invalidates the refresh token so it cannot be reused', async () => {
      const loginRes = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct-password' } }, loginRes);
      const { refreshToken } = loginRes.json.mock.calls[0][0];

      await handleLogout({ body: { refreshToken } }, mockRes());

      const refreshRes = mockRes();
      await handleRefresh({ body: { refreshToken } }, refreshRes);
      expect(refreshRes.status).toHaveBeenCalledWith(401);
    });

    it('succeeds even when no refreshToken is provided', async () => {
      const res = mockRes();
      await handleLogout({ body: {} }, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    });
  });

  // ── Expired access token ───────────────────────────────────────────────────

  describe('expired access token', () => {
    it('auth middleware returns 401 TOKEN_EXPIRED for expired tokens', async () => {
      const jwt = require('jsonwebtoken');
      const { requireAdminAuth } = require('../backend/src/middleware/auth');

      // sign with negative expiresIn so stub marks it expired
      const expiredToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: -1 });

      const req = { headers: { authorization: `Bearer ${expiredToken}` }, ip: '127.0.0.1' };
      const res = mockRes();
      await requireAdminAuth(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    });
  });
});
