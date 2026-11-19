'use strict';

/**
 * #1945 — second-factor attempts on the user MFA endpoints are limited per
 * account, whatever the source IP, and every wrong code is audited.
 *
 * The real authController and mfaController run; only I/O (Redis, Mongo,
 * audit writes, alerts, session store) is mocked.
 */

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
jest.mock('../src/services/sessionStore', () => ({
  getStore: jest.fn(),
  revokeAllUserSessions: jest.fn(async () => 0),
  parseTTL: (_name, fallback) => fallback,
  _resetStore: jest.fn(),
}));

const mockUsers = new Map();
jest.mock('../src/models/userModel', () => ({
  findById: jest.fn(async (id) => mockUsers.get(String(id)) || null),
  findByIdAndUpdate: jest.fn(async () => null),
}));

const { logAudit } = require('../src/services/auditService');
const User = require('../src/models/userModel');
const { encryptMfaSecret, disableUserMfa, verifyAndEnableUserMfa } = require('../src/controllers/mfaController');

const PLAIN_SECRET = 'JBSWY3DPEHPK3PXP';
const WRONG_CODE = (real) => (real === '000000' ? '111111' : '000000');

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    cookie() { return this; },
    clearCookie() { return this; },
  };
}

let ipCounter = 0;
function makeReq(userId, code) {
  ipCounter += 1;
  return {
    user: { userId },
    body: { code },
    cookies: {},
    headers: {},
    // A different source IP on every attempt: the limit must follow the account.
    ip: `203.0.113.${ipCounter % 250}`,
  };
}

function seedUser(suffix) {
  const id = `user-${suffix}-${Math.random().toString(36).slice(2)}`;
  const email = `bursar.${suffix}.${Math.random().toString(36).slice(2, 8)}@school.edu`;
  mockUsers.set(id, {
    _id: id,
    email,
    schoolId: 'sch-1',
    mfaEnabled: true,
    mfaSecret: encryptMfaSecret(PLAIN_SECRET),
  });
  return { id, email };
}

describe('MFA attempt limiting on user endpoints (#1945)', () => {
  beforeEach(() => {
    logAudit.mockClear();
  });

  it('locks the account after five wrong disable codes; the sixth attempt is 429 even with a valid code', async () => {
    const { id } = seedUser('disable-lock');
    const real = speakeasy.totp({ secret: PLAIN_SECRET, encoding: 'base32' });

    for (let i = 0; i < 5; i += 1) {
      const res = makeRes();
      await disableUserMfa(makeReq(id, WRONG_CODE(real)), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('INVALID_MFA_CODE');
    }

    const sixth = makeRes();
    await disableUserMfa(makeReq(id, WRONG_CODE(real)), sixth);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.body.code).toBe('ACCOUNT_LOCKED');

    const withValidCode = makeRes();
    await disableUserMfa(makeReq(id, real), withValidCode);
    expect(withValidCode.statusCode).toBe(429);
    expect(withValidCode.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('locks enrolment verify the same way', async () => {
    const { id } = seedUser('verify-lock');
    const real = speakeasy.totp({ secret: PLAIN_SECRET, encoding: 'base32' });

    for (let i = 0; i < 5; i += 1) {
      const res = makeRes();
      await verifyAndEnableUserMfa(makeReq(id, WRONG_CODE(real)), res);
      expect(res.statusCode).toBe(400);
    }

    const sixth = makeRes();
    await verifyAndEnableUserMfa(makeReq(id, WRONG_CODE(real)), sixth);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('writes one MFA_FAILURE audit row per wrong code', async () => {
    const { id } = seedUser('audit');
    const real = speakeasy.totp({ secret: PLAIN_SECRET, encoding: 'base32' });

    for (let i = 0; i < 3; i += 1) {
      await disableUserMfa(makeReq(id, WRONG_CODE(real)), makeRes());
    }

    const failureRows = logAudit.mock.calls.filter(([row]) => row.action === 'MFA_FAILURE');
    expect(failureRows).toHaveLength(3);
    expect(failureRows[0][0]).toEqual(expect.objectContaining({
      result: 'failure',
      severity: 'high',
      targetId: id,
      details: { reason: 'disable' },
    }));
  });

  it('a correct code clears the failure counter, so the lock needs a fresh run of five failures', async () => {
    const { id } = seedUser('reset');
    const real = speakeasy.totp({ secret: PLAIN_SECRET, encoding: 'base32' });

    for (let i = 0; i < 3; i += 1) {
      await verifyAndEnableUserMfa(makeReq(id, WRONG_CODE(real)), makeRes());
    }
    const success = makeRes();
    await verifyAndEnableUserMfa(makeReq(id, real), success);
    expect(success.statusCode).toBe(200);

    for (let i = 0; i < 4; i += 1) {
      const res = makeRes();
      await verifyAndEnableUserMfa(makeReq(id, WRONG_CODE(real)), res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('does not touch another account when one account is locked', async () => {
    const locked = seedUser('isolation-a');
    const other = seedUser('isolation-b');
    const real = speakeasy.totp({ secret: PLAIN_SECRET, encoding: 'base32' });

    for (let i = 0; i < 5; i += 1) {
      await disableUserMfa(makeReq(locked.id, WRONG_CODE(real)), makeRes());
    }
    const otherRes = makeRes();
    await disableUserMfa(makeReq(other.id, WRONG_CODE(real)), otherRes);
    expect(otherRes.statusCode).toBe(400);
    expect(User.findById).toHaveBeenCalled();
  });
});
