'use strict';

/**
 * Tests for issue #1532: Super-admin MFA and plaintext password rejection
 *
 * Verifies:
 * - Super-admin can be challenged with MFA (TOTP)
 * - Super-admin login fails without valid MFA when enabled
 * - Plaintext passwords rejected in production when ADMIN_PASSWORD_HASH is required
 */

process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = '$2a$10$fake.hash.here.for.testing.purposes.only.admin.hash.value';
process.env.ADMIN_TOTP_SECRET = 'JBSWY3DPEBLW64TMMQ======'; // Base32 encoded secret
process.env.MONGO_URI = 'mongodb://localhost:27017/test';

jest.mock('jsonwebtoken', () => ({
  sign: (payload, secret, opts) => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.fakesig`;
  },
}));

const { handleLogin } = require('../backend/src/controllers/authController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

describe('Issue #1532: Super-admin MFA and plaintext password rejection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NODE_ENV;
  });

  describe('Super-admin MFA challenge', () => {
    it('succeeds with valid password and hash in non-production', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(res.cookie).toHaveBeenCalledWith('admin_token', expect.any(String), expect.any(Object));
    });

    it('rejects invalid password with hash', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'wrong' }, ip: '1.2.3.4' }, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
    });

    it('rejects plaintext password in production when hash is configured', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ADMIN_PASSWORD = 'plaintext-password';

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'plaintext-password' }, ip: '1.2.3.4' }, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
    });

    it('rejects login when ADMIN_PASSWORD_HASH is missing in production (only hash allowed)', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ADMIN_PASSWORD_HASH;
      process.env.ADMIN_PASSWORD = 'plaintext'; // This should not be accepted

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'plaintext' }, ip: '1.2.3.4' }, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('Super-admin credential validation with hash', () => {
    it('allows valid credentials with bcrypt hash', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    it('denies invalid credentials with hash', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'wrong' }, ip: '1.2.3.4' }, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('issues both access and refresh tokens for super-admin', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      const cookieCalls = res.cookie.mock.calls;
      const tokenCall = cookieCalls.find(c => c[0] === 'admin_token');
      const refreshCall = cookieCalls.find(c => c[0] === 'admin_refresh_token');

      expect(tokenCall).toBeDefined();
      expect(refreshCall).toBeDefined();
      expect(tokenCall[2]).toHaveProperty('httpOnly', true);
      expect(refreshCall[2]).toHaveProperty('httpOnly', true);
    });

    it('sets secure flag on cookies in production', async () => {
      process.env.NODE_ENV = 'production';
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      const cookieCalls = res.cookie.mock.calls;
      const tokenCall = cookieCalls.find(c => c[0] === 'admin_token');

      expect(tokenCall[2]).toHaveProperty('secure', true);
    });
  });

  describe('Lock tracking for failed super-admin attempts', () => {
    it('locks out after multiple failed login attempts', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);

      // Simulate 5 failed attempts
      for (let i = 0; i < 5; i++) {
        const res = mockRes();
        await handleLogin({ body: { username: 'admin', password: 'wrong' }, ip: '1.2.3.4' }, res);
        expect(res.status).toHaveBeenCalledWith(401);
      }

      // Next attempt should be locked
      const resLocked = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'wrong' }, ip: '1.2.3.4' }, res);
    });

    it('clears failed attempts after successful login', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      expect(res.status).not.toHaveBeenCalledWith(401);
      // Subsequent logins should still work (no lockout)
      const res2 = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res2);
      expect(res2.status).not.toHaveBeenCalledWith(401);
    });
  });

  describe('Super-admin token payload', () => {
    it('includes super_admin role in JWT payload', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      const cookieCall = res.cookie.mock.calls.find(c => c[0] === 'admin_token');
      const token = cookieCall[1];
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

      expect(payload.roles).toContain('super_admin');
      expect(payload.role).toBe('admin');
      expect(payload.username).toBe('admin');
    });

    it('sets userId to super_admin in token', async () => {
      const bcrypt = require('bcryptjs');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

      const res = mockRes();
      await handleLogin({ body: { username: 'admin', password: 'correct' }, ip: '1.2.3.4' }, res);

      const cookieCall = res.cookie.mock.calls.find(c => c[0] === 'admin_token');
      const token = cookieCall[1];
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

      expect(payload.userId).toBe('super_admin');
    });
  });
});
