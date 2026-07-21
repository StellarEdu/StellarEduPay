'use strict';

/**
 * Tests for the admin login handler logic (issue #553).
 *
 * Tests the pure handler function directly — no Express, no JWT lib needed.
 */

process.env.JWT_SECRET = 'test-secret-for-jest';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-password';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';

// jsonwebtoken is a backend dep not available at root — provide a minimal stub
jest.mock('jsonwebtoken', () => ({
  sign: (payload, secret, opts) => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.fakesig`;
  },
}), { virtual: true });

const { handleLogin } = require('../backend/src/controllers/authController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

describe('handleLogin', () => {
  it('returns 401 for wrong password', () => {
    const res = mockRes();
    handleLogin({ body: { username: 'admin', password: 'wrong' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
  });

  it('returns 401 for wrong username', () => {
    const res = mockRes();
    handleLogin({ body: { username: 'hacker', password: 'correct-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
  });

  it('returns 401 when body is empty', () => {
    const res = mockRes();
    handleLogin({ body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
  });

  it('returns a token with role:admin for valid credentials', async () => {
    const res = mockRes();
    // The success path is async now (#595 awaits issueRefreshToken before
    // res.json), so the call must be awaited before asserting on res.
    await handleLogin({ body: { username: 'admin', password: 'correct-password' } }, res);
    expect(res.status).not.toHaveBeenCalled();
    const [body] = res.json.mock.calls[0];
    // Token is now in the HttpOnly cookie, not the response body
    expect(body.token).toBeUndefined();
    expect(body.isAdmin).toBe(true);
    // Cookie must carry the JWT with role:admin
    expect(res.cookie).toHaveBeenCalledWith('admin_token', expect.any(String), expect.objectContaining({ httpOnly: true }));
    const cookieToken = res.cookie.mock.calls[0][1];
    const payload = JSON.parse(Buffer.from(cookieToken.split('.')[1], 'base64url').toString());
    expect(payload.role).toBe('admin');
    expect(payload.username).toBe('admin');
  });

  it('returns 500 when ADMIN_USERNAME is not configured', () => {
    const saved = process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_USERNAME;
    const res = mockRes();
    handleLogin({ body: { username: 'admin', password: 'correct-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_MISCONFIGURED' }));
    process.env.ADMIN_USERNAME = saved;
  });
});

describe('config — JWT_SECRET enforcement', () => {
  it('throws a clear error when JWT_SECRET is missing in production', () => {
    const savedSecret = process.env.JWT_SECRET;
    const savedEnv = process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    expect(() => {
      jest.isolateModules(() => {
        require('../backend/src/config/index.js');
      });
    }).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = savedSecret;
    process.env.NODE_ENV = savedEnv;
  });
});
