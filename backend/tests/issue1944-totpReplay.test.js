'use strict';

/**
 * TOTP codes cannot be replayed within their validity window (#1944).
 *
 * Verification used a window of one step with no record of what had been
 * accepted, so a code stayed usable for about 90 seconds after first use.
 * RFC 6238 §5.2 requires a verifier to refuse a second use of an OTP.
 *
 * The User model is an in-memory stand-in whose conditional updateOne applies
 * the same { $or: [null, {$lt}] } check-and-set that MongoDB would, so the
 * concurrency assertions exercise the real decision logic. Codes are produced
 * by speakeasy itself, at chosen times, so the window and step arithmetic are
 * exercised for real.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'issue1944-test-secret-value-32-bytes!!';

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/models/schoolModel', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/userModel', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
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
const { handleLogin } = require('../src/controllers/authController');
const { verifyUserTotp, encryptMfaSecret, hashBackupCodes } = require('../src/controllers/mfaController');

const PASSWORD = 'correct-horse-1944';
const BASE32_SECRET = 'JBSWY3DPEBLW64TMMQ======';
const STEP = 30;
const BACKUP_CODES = ['23456-ABCDE', '7FGHJ-KMNPQ'];

let userSeq = 0;

function codeAt(unixSeconds) {
  return speakeasy.totp({ secret: BASE32_SECRET, encoding: 'base32', time: unixSeconds });
}

function currentStep() {
  return Math.floor(Date.now() / 1000 / STEP);
}

// Stand-in for the stored user document. updateOne applies the conditional
// write the way MongoDB does for the filter shapes the code uses.
function installFakeUser(db) {
  const snapshot = () => JSON.parse(JSON.stringify(db));
  User.findOne.mockImplementation(async () => snapshot());
  User.findById.mockImplementation(async () => snapshot());
  User.findOneAndUpdate.mockImplementation(async () => snapshot());
  User.updateOne.mockImplementation(async (filter, update) => {
    if (String(filter._id) !== String(db._id)) return { matchedCount: 0, modifiedCount: 0 };
    const allowed = (filter.$or || []).some((cond) => {
      const v = cond.mfaLastUsedStep;
      if (v === null) return db.mfaLastUsedStep == null;
      if (v && typeof v === 'object' && '$lt' in v) {
        return db.mfaLastUsedStep != null && db.mfaLastUsedStep < v.$lt;
      }
      return false;
    });
    if (!allowed) return { matchedCount: 0, modifiedCount: 0 };
    db.mfaLastUsedStep = update.$set.mfaLastUsedStep;
    return { matchedCount: 1, modifiedCount: 1 };
  });
}

async function makeUser() {
  userSeq += 1;
  const userId = `user-1944-${userSeq}`;
  const db = {
    _id: userId,
    email: `${userId}@school.test`,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    isActive: true,
    mfaEnabled: true,
    mfaSecret: encryptMfaSecret(BASE32_SECRET),
    mfaLastUsedStep: null,
    mfaBackupCodes: (await hashBackupCodes(BACKUP_CODES)).map((hash) => ({ hash, algo: 'bcrypt', used: false })),
    schoolId: 'SCH-1944',
    roles: ['owner'],
  };
  installFakeUser(db);
  return db;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.post('/login', handleLogin);
  return app;
}

describe('TOTP replay protection (#1944)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe('verifyUserTotp', () => {
    it('accepts a valid code once and rejects the same code on second use', async () => {
      const db = await makeUser();
      const code = codeAt(Date.now() / 1000);

      expect(await verifyUserTotp(db, code)).toBe(true);
      expect(db.mfaLastUsedStep).toBe(currentStep());

      expect(await verifyUserTotp(db, code)).toBe(false);
    });

    it('lets exactly one of two concurrent uses of one code succeed', async () => {
      const db = await makeUser();
      const code = codeAt(Date.now() / 1000);

      const results = await Promise.all([verifyUserTotp(db, code), verifyUserTotp(db, code)]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('rejects a code from the previous step once a later step has been accepted', async () => {
      const db = await makeUser();
      const now = Date.now() / 1000;
      const previousStepCode = codeAt(now - STEP);
      const currentStepCode = codeAt(now);

      expect(await verifyUserTotp(db, currentStepCode)).toBe(true);

      // The earlier step is still inside the window but is now older than the
      // last accepted step, so it must not be accepted.
      expect(await verifyUserTotp(db, previousStepCode)).toBe(false);
    });

    it('accepts a previous-step code when no later step has been accepted', async () => {
      const db = await makeUser();
      const previousStepCode = codeAt(Date.now() / 1000 - STEP);

      expect(await verifyUserTotp(db, previousStepCode)).toBe(true);
    });

    it('rejects a wrong code without recording a step', async () => {
      const db = await makeUser();

      expect(await verifyUserTotp(db, '000000')).toBe(false);
      expect(db.mfaLastUsedStep).toBeNull();
    });
  });

  describe('login', () => {
    it('logs in with a TOTP code, and refuses the same code on a second login', async () => {
      const db = await makeUser();
      const code = codeAt(Date.now() / 1000);

      const first = await request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: code });
      expect(first.status).toBe(200);

      const replay = await request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: code });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('INVALID_MFA_CODE');
    });

    it('lets exactly one of two concurrent logins with the same TOTP code succeed', async () => {
      const db = await makeUser();
      const code = codeAt(Date.now() / 1000);

      const [a, b] = await Promise.all([
        request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: code }),
        request(app).post('/login').send({ email: db.email, password: PASSWORD, mfaCode: code }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 401]);
    });
  });
});
