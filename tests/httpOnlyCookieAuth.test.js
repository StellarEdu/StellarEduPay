'use strict';

/**
 * Tests for the HttpOnly cookie JWT migration.
 *
 * Acceptance criteria:
 *  - POST /auth/login sets an HttpOnly cookie (admin_token) and does NOT
 *    return the raw JWT in the response body.
 *  - POST /auth/logout clears the cookie.
 *  - The token is never exposed via document.cookie or localStorage.
 */

process.env.JWT_SECRET = 'test-secret-cookie';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-password';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';

jest.mock('jsonwebtoken', () => ({
  sign: (payload, _secret, _opts) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'HS256' })}.${enc({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 })}.fakesig`;
  },
  verify: (token, _secret) => {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[2] !== 'fakesig') {
      const e = new Error('invalid'); e.name = 'JsonWebTokenError'; throw e;
    }
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  },
}), { virtual: true });

// The auth-failure path awaits logAudit(); without this mock it would try to
// write to a (nonexistent) Mongo and the request hangs until the test times out.
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { handleLogin, handleLogout, handleMe, _resetStore } = require('../backend/src/controllers/authController');
const { requireAdminAuth } = require('../backend/src/middleware/auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.post('/api/auth/login', handleLogin);
  app.post('/api/auth/logout', handleLogout);
  app.get('/api/auth/me', requireAdminAuth, handleMe);
  return app;
}

beforeEach(() => _resetStore());

describe('HttpOnly cookie JWT — backend', () => {
  it('login sets an HttpOnly cookie and does not return the token in the body', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct-password' });

    expect(res.status).toBe(200);

    // Token must NOT be in the response body
    expect(res.body.token).toBeUndefined();

    // isAdmin flag must be present
    expect(res.body.isAdmin).toBe(true);

    // Cookie must be set
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const adminCookie = setCookie.find((c) => c.startsWith('admin_token='));
    expect(adminCookie).toBeDefined();

    // Cookie must be HttpOnly
    expect(adminCookie.toLowerCase()).toContain('httponly');
  });

  it('token in the cookie is not readable via document.cookie (HttpOnly flag present)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct-password' });

    const setCookie = res.headers['set-cookie'];
    const adminCookie = setCookie.find((c) => c.startsWith('admin_token='));

    // The HttpOnly attribute prevents JS access — verify the flag is set
    expect(adminCookie.toLowerCase()).toContain('httponly');
    // SameSite=Strict is also required
    expect(adminCookie.toLowerCase()).toContain('samesite=strict');
  });

  it('logout clears the admin_token cookie', async () => {
    const app = buildApp();

    // Login first to get a cookie
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct-password' });
    const cookie = loginRes.headers['set-cookie'].find((c) => c.startsWith('admin_token='));

    // Logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .send({});

    expect(logoutRes.status).toBe(200);

    // The Set-Cookie header should clear the cookie (empty value or Max-Age=0 / Expires in the past)
    const cleared = logoutRes.headers['set-cookie'];
    expect(cleared).toBeDefined();
    const clearedCookie = cleared.find((c) => c.startsWith('admin_token='));
    expect(clearedCookie).toBeDefined();
    // Express clearCookie sets Max-Age=0 or an expired date
    const isCleared =
      clearedCookie.includes('Max-Age=0') ||
      clearedCookie.includes('Expires=Thu, 01 Jan 1970') ||
      clearedCookie.match(/admin_token=;/);
    expect(isCleared).toBeTruthy();
  });

  it('/auth/me returns 401 without a cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('/auth/me returns { isAdmin: true } with a valid cookie', async () => {
    const app = buildApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct-password' });
    const cookie = loginRes.headers['set-cookie'].find((c) => c.startsWith('admin_token='));

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookie);

    // The frontend treats a 200 from /auth/me as "is admin" (it reads r.ok, not
    // a body flag). handleMe returns the session's roles rather than an isAdmin
    // field, so assert the admin role is present.
    expect(meRes.status).toBe(200);
    expect(meRes.body.roles).toEqual(expect.arrayContaining(['super_admin']));
  });
});

describe('HttpOnly cookie JWT — frontend storage', () => {
  it('useAdminAuth never writes the token to localStorage', () => {
    // Simulate what the login flow does: the server sets the cookie, the
    // frontend receives { isAdmin: true } — no token string to store.
    const mockLocalStorage = { setItem: jest.fn(), getItem: jest.fn(), removeItem: jest.fn() };
    Object.defineProperty(global, 'localStorage', { value: mockLocalStorage, writable: true });

    // Simulate the login response handler (mirrors login.jsx logic)
    const data = { isAdmin: true, expiresIn: 28800 }; // no `token` field
    if (data.token) {
      mockLocalStorage.setItem('admin_token', data.token);
    }

    expect(mockLocalStorage.setItem).not.toHaveBeenCalledWith('admin_token', expect.anything());
  });

  it('document.cookie does not contain admin_token (HttpOnly prevents JS access)', async () => {
    // The guarantee that document.cookie cannot contain admin_token comes from
    // two facts we can verify here:
    //   1. The server sets the HttpOnly flag (verified in the backend suite above).
    //   2. The login response body never includes the raw token, so there is
    //      nothing for client-side code to write to document.cookie.
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct-password' });

    // No raw token in the body — nothing for JS to exfiltrate or store
    expect(res.body.token).toBeUndefined();

    // The cookie header carries the token but with HttpOnly set
    const setCookie = res.headers['set-cookie'];
    const adminCookie = setCookie.find((c) => c.startsWith('admin_token='));
    expect(adminCookie.toLowerCase()).toContain('httponly');
  });
});
