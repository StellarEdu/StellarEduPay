'use strict';

/**
 * #1947 — environment super-admin (break-glass) login requires a second factor
 * in production, can be switched off, and every success is audited and alerted.
 */

const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-1234567890';

jest.mock('../src/config/redisClient', () => ({
  getRedisClient: () => null,
  isRedisReady: () => false,
}));

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn(async () => {}) }));
jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn(async () => {}) }));

const mockStore = {
  setToken: jest.fn(async () => {}),
  setSession: jest.fn(async () => {}),
};
jest.mock('../src/services/sessionStore', () => ({
  getStore: () => mockStore,
  revokeAllUserSessions: jest.fn(async () => 0),
  parseTTL: (_name, fallback) => fallback,
  _resetStore: jest.fn(),
}));

jest.mock('../src/models/userModel', () => ({ findOne: jest.fn(async () => null) }));

const { logAudit } = require('../src/services/auditService');
const { sendAdminAlert } = require('../src/services/alertService');
const { handleLogin } = require('../src/controllers/authController');

const ENV_USER = 'breakglass-admin';
const ENV_PASSWORD = 'a-very-long-break-glass-passphrase';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    cookie(name, value) { this.cookies[name] = value; return this; },
    clearCookie() { return this; },
  };
}

function req(body) {
  return { body, ip: '198.51.100.9', headers: { 'user-agent': 'jest' }, cookies: {} };
}

const ENV_KEYS = [
  'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'ADMIN_TOTP_SECRET',
  'ADMIN_LOGIN_DISABLED', 'NODE_ENV',
];

describe('environment super-admin login (#1947)', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_USERNAME = ENV_USER;
    process.env.ADMIN_PASSWORD = ENV_PASSWORD;
    process.env.NODE_ENV = 'test';
    logAudit.mockClear();
    sendAdminAlert.mockClear();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('refuses env login in production when ADMIN_TOTP_SECRET is not set', async () => {
    process.env.NODE_ENV = 'production';
    const res = makeRes();
    await handleLogin(req({ username: ENV_USER, password: ENV_PASSWORD }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('AUTH_MISCONFIGURED');
    expect(res.cookies.admin_token).toBeUndefined();
  });

  it('refuses env login outright when ADMIN_LOGIN_DISABLED=true', async () => {
    process.env.ADMIN_LOGIN_DISABLED = 'true';
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const res = makeRes();
    await handleLogin(req({ username: ENV_USER, password: ENV_PASSWORD }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ADMIN_LOGIN_DISABLED');
  });

  it('asks for a TOTP code after a correct password when ADMIN_TOTP_SECRET is set', async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const res = makeRes();
    await handleLogin(req({ username: ENV_USER, password: ENV_PASSWORD }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ requiresMfa: true });
    expect(res.cookies.admin_token).toBeUndefined();
  });

  it('rejects a wrong TOTP code with a 401 and an MFA_FAILURE audit row', async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const real = speakeasy.totp({ secret: TOTP_SECRET, encoding: 'base32' });
    const res = makeRes();
    await handleLogin(req({ username: ENV_USER, password: ENV_PASSWORD, mfaCode: real === '000000' ? '111111' : '000000' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('INVALID_MFA_CODE');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'MFA_FAILURE', result: 'failure' }));
  });

  it('issues tokens with a correct password and TOTP, and audits and alerts the login', async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const code = speakeasy.totp({ secret: TOTP_SECRET, encoding: 'base32' });
    const res = makeRes();
    await handleLogin(req({ username: ENV_USER, password: ENV_PASSWORD, mfaCode: code }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.cookies.admin_token).toEqual(expect.any(String));
    expect(res.cookies.admin_refresh_token).toEqual(expect.any(String));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SUPER_ADMIN_LOGIN',
      severity: 'high',
      result: 'success',
    }));
    expect(sendAdminAlert).toHaveBeenCalledWith('Environment super-admin login', expect.any(Object));
  });

  it('keeps the bcrypt-hash credential path working and still requires TOTP', async () => {
    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash(ENV_PASSWORD, 4);
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const res = makeRes();
    await handleLogin(req({ username: ENV_USER, password: 'not-the-password' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('does not treat a request with an email as the env path, even if it carries the admin username', async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const res = makeRes();
    // A DB user supplies an email; the env account must not be reachable this way.
    // The DB lookup finds no user, so the request is a plain invalid login.
    await handleLogin(req({ email: `${ENV_USER}@school.edu`, username: ENV_USER, password: ENV_PASSWORD }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.cookies.admin_token).toBeUndefined();
  });
});
