'use strict';

/**
 * End-to-end integration test for issue #1390 — the full user-level MFA
 * lifecycle exercised through the actual HTTP layer (supertest against the
 * real Express app), not just the controller unit tests in
 * tests/mfa-totp.test.js.
 *
 * Covers: login -> MFA setup -> TOTP verify -> step-up authentication for a
 * sensitive action (rejecting a stale mfaSetupPending token even though it
 * is not expired) -> backup code usage -> backup code exhaustion ->
 * re-enrollment.
 *
 * There is no public self-service "register" endpoint in this codebase
 * (accounts are provisioned out of band) — the fixture below stands in for
 * that step, exactly as the mocked User documents in tests/mfa-totp.test.js
 * and tests/unsubscribe-xss.test.js do.
 *
 * Unlike tests/mfa-totp.test.js, this file does NOT mock
 * backend/src/middleware/auth — JWTs are signed and verified for real, so
 * the mfaSetupPending step-up gate is exercised as it actually runs in
 * production, not bypassed.
 */

process.env.MONGO_URI             = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET             = 'test-jwt-secret-1234567890abcdef';
process.env.REQUIRE_MFA            = 'true';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  connection: {
    on: jest.fn(), once: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    readyState: 1,
  },
  Schema: class {
    constructor() {
      this.index = jest.fn(); this.pre = jest.fn(); this.post = jest.fn();
      this.plugin = jest.fn(); this.set = jest.fn();
      this.virtual = jest.fn().mockReturnValue({ get: jest.fn() });
    }
  },
  model: jest.fn().mockReturnValue({}),
}));

// bcryptjs is mocked deterministically: passwordHash is always `HASH:<plaintext>`
// so we can drive a real password-change round trip without real hashing.
jest.mock('bcryptjs', () => ({
  compare: jest.fn((candidate, hash) => Promise.resolve(hash === `HASH:${candidate}`)),
  hash: jest.fn((plain) => Promise.resolve(`HASH:${plain}`)),
  genSalt: jest.fn().mockResolvedValue('$2a$10$salt'),
}));

// speakeasy is resolved from two different node_modules trees depending on
// whether the requiring module lives under backend/ or the repo root (see
// tests/mfa-totp.test.js for the same duplicate-mock necessity). The mock
// TOTP secret is fixed and the mock only accepts token '123456'.
const FIXED_SECRET = 'JBSWY3DPEBLW64TMMQ======';
const mockSpeakeasyFactory = () => ({
  generateSecret: jest.fn().mockReturnValue({
    base32: FIXED_SECRET,
    otpauth_url: `otpauth://totp/StellarEduPay?secret=${FIXED_SECRET}&issuer=StellarEduPay`,
  }),
  totp: {
    verify: jest.fn((opts) => opts.secret === FIXED_SECRET && opts.encoding === 'base32' && opts.token === '123456'),
  },
});
jest.mock('speakeasy', () => mockSpeakeasyFactory());
jest.mock('../backend/node_modules/speakeasy', () => mockSpeakeasyFactory());

// ── Stateful User model mock ──────────────────────────────────────────────────
// A single in-memory "document" mutated by findByIdAndUpdate($set, including
// dotted paths like `mfaBackupCodes.3.used`) and by save() on the object
// returned from findById/findOne, mirroring real Mongoose document semantics
// closely enough to drive the full setup -> verify -> login -> disable cycle.

const mockUserStore = {
  _id: 'user-001',
  email: 'owner@test-school.edu',
  passwordHash: 'HASH:OldPassw0rd!',
  schoolId: 'SCH001',
  roles: ['owner'],
  isActive: true,
  mfaEnabled: false,
  mfaSecret: null,
  mfaBackupCodes: [],
};

function applySet(target, setOps) {
  for (const [path, value] of Object.entries(setOps || {})) {
    const parts = path.split('.');
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }
}

function makeUserDoc() {
  const doc = { ...mockUserStore, mfaBackupCodes: mockUserStore.mfaBackupCodes.map((c) => ({ ...c })) };
  doc.save = jest.fn(async () => {
    const { save, ...rest } = doc;
    Object.assign(mockUserStore, rest);
    return doc;
  });
  return doc;
}

const mockFindOne          = jest.fn((query) => Promise.resolve(
  query?.email === mockUserStore.email && mockUserStore.isActive ? makeUserDoc() : null
));
const mockFindById         = jest.fn((id) => Promise.resolve(String(id) === mockUserStore._id ? makeUserDoc() : null));
const mockFindByIdAndUpdate = jest.fn((id, update) => {
  if (String(id) === mockUserStore._id) applySet(mockUserStore, update?.$set);
  return Promise.resolve(makeUserDoc());
});

jest.mock('../backend/src/models/userModel', () => ({
  findOne:           (...a) => mockFindOne(...a),
  findById:           (...a) => mockFindById(...a),
  findByIdAndUpdate:  (...a) => mockFindByIdAndUpdate(...a),
}));

// No school-level MFA involved in this test — school lookups resolve null so
// the login handler's MFA check falls through to the user-level path only.
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/models/auditLogModel', () => {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    bypassTenantScope: jest.fn().mockResolvedValue(null),
  };
  return { create: jest.fn().mockResolvedValue({ _id: 'log-001' }), findOne: jest.fn(() => chain) };
});

jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  del: jest.fn(),
  flushAll: jest.fn(),
  KEYS: {},
  TTL: {},
}));

// ── Broad service/scheduler mocks so requiring app.js doesn't try to reach a
// real database, Redis, or Stellar network (mirrors tests/unsubscribe-xss.test.js) ──
jest.mock('../backend/src/config/retryQueueSetup', () => ({ initializeRetryQueue: jest.fn(), setupMonitoring: jest.fn() }));
jest.mock('../backend/src/services/retryService', () => ({ queueForRetry: jest.fn(), startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(), isRetryWorkerRunning: jest.fn().mockReturnValue(false) }));
jest.mock('../backend/src/services/retryServiceSelector', () => ({ start: jest.fn(), stop: jest.fn(), useBullMQ: jest.fn().mockReturnValue(false) }));
jest.mock('../backend/src/services/stuckPaymentReconciliation', () => ({ reconcileStuckPayments: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/transactionQueueService', () => ({ startWorker: jest.fn(), stopWorker: jest.fn() }));
jest.mock('../backend/src/queue/transactionQueue', () => ({ recoverPendingJobs: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/leaderElection', () => ({ register: jest.fn(), start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/outboxDispatcher', () => ({ startOutboxDispatcher: jest.fn() }));
jest.mock('../backend/src/services/sessionCleanupService', () => ({ startSessionCleanupScheduler: jest.fn(), stopSessionCleanupScheduler: jest.fn() }));
jest.mock('../backend/src/services/auditLogCleanupService', () => ({ startAuditLogCleanupScheduler: jest.fn(), stopAuditLogCleanupScheduler: jest.fn() }));
jest.mock('../backend/src/services/webhookRetryScheduler', () => ({ startWebhookRetryScheduler: jest.fn(), stopWebhookRetryScheduler: jest.fn() }));
jest.mock('../backend/src/services/reconciliationReportScheduler', () => ({ startReconciliationReportScheduler: jest.fn(), stopReconciliationReportScheduler: jest.fn() }));
jest.mock('../backend/src/services/reconciliationService', () => ({ startReconciliationScheduler: jest.fn(), stopReconciliationScheduler: jest.fn() }));
jest.mock('../backend/src/services/metricsRollupService', () => ({ startMetricsRollupScheduler: jest.fn(), stopMetricsRollupScheduler: jest.fn() }));
jest.mock('../backend/src/services/paymentSavedSubscribers', () => ({ registerPaymentSavedSubscribers: jest.fn() }));
jest.mock('../backend/src/services/transactionPollingService', () => ({ startPolling: jest.fn(), stopPolling: jest.fn() }));
jest.mock('../backend/src/services/consistencyScheduler', () => ({ startConsistencyScheduler: jest.fn(), stopConsistencyScheduler: jest.fn() }));
jest.mock('../backend/src/services/concurrentPaymentProcessor', () => ({
  concurrentPaymentProcessor: { getStats: jest.fn().mockReturnValue({ queueDepth: 0, maxQueueDepth: 1000 }) },
}), { virtual: true });
jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(), stopReminderScheduler: jest.fn(),
  processReminders: jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
  getReminderStatus: jest.fn().mockReturnValue({ scheduled: false }),
}));
jest.mock('../backend/src/services/piiAnonymizationScheduler', () => ({ startPiiAnonymizationScheduler: jest.fn(), stopPiiAnonymizationScheduler: jest.fn() }));
jest.mock('../backend/src/services/jobRecoveryScheduler', () => ({ startJobRecoveryScheduler: jest.fn(), stopJobRecoveryScheduler: jest.fn() }));
jest.mock('../backend/src/services/reportQueueService', () => ({ startWorker: jest.fn(), stopWorker: jest.fn() }));
jest.mock('../backend/src/services/reportCacheInvalidator', () => ({ close: jest.fn() }));
jest.mock('../backend/src/services/bullMQRetryService', () => ({}), { virtual: true });
jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments: jest.fn().mockResolvedValue(undefined),
  syncPaymentsForSchool: jest.fn().mockResolvedValue(undefined),
  verifyTransaction: jest.fn().mockResolvedValue({}),
  recordPayment: jest.fn().mockResolvedValue({}),
  finalizeConfirmedPayments: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) => Promise.resolve(p)),
  isSupportedCurrency: jest.fn().mockResolvedValue({ valid: true }),
  getSupportedCurrencies: jest.fn().mockResolvedValue(new Set(['usd', 'eur'])),
  _getRates: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/sseService', () => ({
  emit: jest.fn(), addClient: jest.fn().mockReturnValue(true),
  removeClient: jest.fn(), getStats: jest.fn().mockReturnValue({ schools: 0, connections: 0 }),
  close: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/webhookService', () => ({
  fireWebhook: jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentConfirmed: jest.fn(), notifyPaymentPending: jest.fn(),
  notifyPaymentFailed: jest.fn(), notifyPaymentRefunded: jest.fn(),
  notifyPaymentSuspicious: jest.fn(), notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(), generateSignature: jest.fn().mockReturnValue('sig'),
  verifySignature: jest.fn().mockReturnValue(true),
}));
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getAuditHealth: jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const request = require('supertest');
const app = require('../backend/src/app');

/** Extracts `name=value` from a supertest response's Set-Cookie header. */
function extractCookie(res, name) {
  const raw = res.headers['set-cookie'] || [];
  const entry = raw.find((c) => c.startsWith(`${name}=`));
  if (!entry) return null;
  return entry.split(';')[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MFA enrollment + TOTP verification lifecycle — end to end (#1390)', () => {
  beforeAll(() => {
    // "Registration" — this codebase provisions accounts out of band (no
    // public self-service register endpoint); this stands in for that step.
    Object.assign(mockUserStore, {
      passwordHash: 'HASH:OldPassw0rd!',
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: [],
    });
  });

  let pendingCookie;   // token minted before MFA setup is complete (mfaSetupPending)
  let freshCookie;     // token reissued once MFA setup completes
  let backupCodes = [];

  test('login before MFA setup returns a restricted (mfaSetupPending) session', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'OldPassw0rd!' });

    expect(res.status).toBe(200);
    expect(res.body.mfaSetupRequired).toBe(true);

    pendingCookie = extractCookie(res, 'admin_token');
    expect(pendingCookie).toBeTruthy();
  });

  test('the restricted token cannot reach a sensitive endpoint before MFA setup', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', pendingCookie)
      .send({ currentPassword: 'OldPassw0rd!', newPassword: 'Irrelevant123!' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_SETUP_REQUIRED');
  });

  test('MFA setup issues a secret and 10 backup codes', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/user/setup')
      .set('Cookie', pendingCookie)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.secret).toBe(FIXED_SECRET);
    expect(res.body.backupCodes).toHaveLength(10);
    backupCodes = res.body.backupCodes;
  });

  test('TOTP verification enables MFA and reissues a non-restricted token', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/user/verify')
      .set('Cookie', pendingCookie)
      .send({ secret: FIXED_SECRET, code: '123456' });

    expect(res.status).toBe(200);
    expect(mockUserStore.mfaEnabled).toBe(true);

    freshCookie = extractCookie(res, 'admin_token');
    expect(freshCookie).toBeTruthy();
    expect(freshCookie).not.toBe(pendingCookie);
  });

  test('step-up: the stale pre-verification token is still rejected even though it has not expired', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', pendingCookie)
      .send({ currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd1!' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_SETUP_REQUIRED');
  });

  test('step-up: the fresh post-verification token can reach the sensitive endpoint', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', freshCookie)
      .send({ currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd1!' });

    expect(res.status).toBe(200);
    expect(mockUserStore.passwordHash).toBe('HASH:NewPassw0rd1!');
  });

  test('login now requires an MFA code', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!' });

    expect(res.status).toBe(200);
    expect(res.body.requiresMfa).toBe(true);
  });

  test('login succeeds with a valid TOTP code', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!', mfaCode: '123456' });

    expect(res.status).toBe(200);
    expect(extractCookie(res, 'admin_token')).toBeTruthy();
  });

  test('backup code usage: login succeeds with an unused backup code and marks it used', async () => {
    const code = backupCodes[0];
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!', mfaCode: code });

    expect(res.status).toBe(200);
    expect(mockUserStore.mfaBackupCodes[0].used).toBe(true);
  });

  test('a used backup code cannot be reused', async () => {
    const code = backupCodes[0];
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!', mfaCode: code });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_MFA_CODE');
  });

  test('backup code exhaustion: once every code is used, no backup code logs in', async () => {
    // Mark all remaining codes used directly (equivalent to having consumed
    // them one login at a time) rather than spending 8 more HTTP round trips
    // against the shared /login rate limiter.
    mockUserStore.mfaBackupCodes.forEach((c) => { c.used = true; });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!', mfaCode: backupCodes[1] });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_MFA_CODE');

    // TOTP still works — only the backup codes are exhausted, not MFA itself.
    const totpRes = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!', mfaCode: '123456' });
    expect(totpRes.status).toBe(200);
  });

  test('re-enrollment: disabling and re-enabling MFA issues a fresh secret and backup codes', async () => {
    const disableRes = await request(app)
      .post('/api/auth/mfa/user/disable')
      .set('Cookie', freshCookie)
      .send({ code: '123456' });

    expect(disableRes.status).toBe(200);
    expect(mockUserStore.mfaEnabled).toBe(false);
    expect(mockUserStore.mfaSecret).toBeNull();
    expect(mockUserStore.mfaBackupCodes).toHaveLength(0);

    // Logging in again is restricted (mfaSetupPending) again, exactly as on
    // first enrollment, since REQUIRE_MFA is still on and MFA is now off.
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: mockUserStore.email, password: 'NewPassw0rd1!' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.mfaSetupRequired).toBe(true);
    const reEnrollCookie = extractCookie(loginRes, 'admin_token');

    const setupRes = await request(app)
      .post('/api/auth/mfa/user/setup')
      .set('Cookie', reEnrollCookie)
      .send();
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.backupCodes).toHaveLength(10);

    const verifyRes = await request(app)
      .post('/api/auth/mfa/user/verify')
      .set('Cookie', reEnrollCookie)
      .send({ secret: setupRes.body.secret, code: '123456' });
    expect(verifyRes.status).toBe(200);
    expect(mockUserStore.mfaEnabled).toBe(true);
  });
});
