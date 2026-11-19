'use strict';

/**
 * MFA backup codes are strictly single-use (#1943).
 *
 * Login used to mark a backup code used with a fire-and-forget update keyed by
 * array index and with no "still unused" precondition. Two concurrent logins
 * could both succeed, and a failed write was silently ignored.
 *
 * The User model here is a small in-memory stand-in whose conditional update
 * enforces the same check-and-set semantics MongoDB applies to
 * { _id, 'mfaBackupCodes.<i>.used': false }, so the concurrency assertions
 * exercise the real decision logic.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'issue1943-test-secret-value-32-bytes!!';

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/models/schoolModel', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/userModel', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../src/services/sessionStore', () => ({
  getStore: () => ({
    setToken: jest.fn().mockResolvedValue(undefined),
    setSession: jest.fn().mockResolvedValue(undefined),
  }),
  revokeAllUserSessions: jest.fn(),
  parseTTL: (_name, fallback) => fallback,
  _resetStore: jest.fn(),
}));

const User = require('../src/models/userModel');
const { logAudit } = require('../src/services/auditService');
const { handleLogin } = require('../src/controllers/authController');
const { hashBackupCodes, encryptMfaSecret } = require('../src/controllers/mfaController');

const PASSWORD = 'correct-horse-1943';
const CODES = ['23456-ABCDE', '7FGHJ-KMNPQ', 'RSTVW-XYZ01', '23456-FGHJK'];

// Each test gets its own user id so the per-user backup-code rate limiter
// (which is keyed on user id) never leaks between tests.
let userSeq = 0;

// In-memory stand-in for the stored user document.
function makeDb(userId, hashes) {
  return {
    _id: userId,
    email: `${userId}@school.test`,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    isActive: true,
    mfaEnabled: true,
    mfaSecret: encryptMfaSecret('JBSWY3DPEBLW64TMMQ======'),
    mfaBackupCodes: hashes.map((hash) => ({ hash, algo: 'bcrypt', used: false })),
    schoolId: 'SCH-1943',
    roles: ['owner'],
  };
}

function clone(doc) {
  return doc ? JSON.parse(JSON.stringify(doc)) : null;
}

// Conditional update: applies only if the targeted code is still unused.
function installFakeUserStore(db) {
  User.findOne.mockImplementation(async () => clone(db));
  User.findById.mockImplementation(async () => clone(db));
  User.findOneAndUpdate.mockImplementation(async (filter, update) => {
    const key = Object.keys(filter).find((k) => k.startsWith('mfaBackupCodes.'));
    const idx = Number(key.split('.')[1]);
    if (db.mfaBackupCodes[idx].used !== filter[key]) return null;
    for (const [path, value] of Object.entries(update.$set)) {
      const [, i, field] = path.split('.');
      db.mfaBackupCodes[Number(i)][field] = value;
    }
    return clone(db);
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.post('/login', handleLogin);
  return app;
}

async function setup() {
  userSeq += 1;
  const userId = `user-1943-${userSeq}`;
  const hashes = await hashBackupCodes(CODES);
  const db = makeDb(userId, hashes);
  installFakeUserStore(db);
  return { db, userId };
}

describe('MFA backup codes are single-use (#1943)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('accepts a valid backup code once, then rejects the same code', async () => {
    const { db } = await setup();

    const first = await request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: CODES[0] });
    expect(first.status).toBe(200);
    expect(db.mfaBackupCodes[0].used).toBe(true);

    const second = await request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: CODES[0] });
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('INVALID_MFA_CODE');
  });

  it('lets exactly one of two concurrent logins succeed with the same code', async () => {
    const { db } = await setup();

    const [a, b] = await Promise.all([
      request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: CODES[1] }),
      request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: CODES[1] }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    expect(db.mfaBackupCodes[1].used).toBe(true);
  });

  it('fails the login when marking the code used fails, rather than ignoring it', async () => {
    const { db } = await setup();
    User.findOneAndUpdate.mockRejectedValueOnce(new Error('primary stepped down'));

    const res = await request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: CODES[2] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_DB_ERROR');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('writes an MFA_BACKUP_CODE_USED audit entry on success', async () => {
    const { db } = await setup();

    await request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: CODES[3] });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MFA_BACKUP_CODE_USED',
      details: expect.objectContaining({ remainingCodes: CODES.length - 1 }),
    }));
  });
});
