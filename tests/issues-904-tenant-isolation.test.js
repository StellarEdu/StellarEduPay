'use strict';

/**
 * Tests for Issue #904
 * - Source validation rules are tenant-scoped by schoolId
 * - All queries include schoolId from req.schoolId
 * - School A cannot read/delete School B's rules
 * - Duplicate check is per-school (same name allowed across schools)
 * - Unmatched-sender default: ALLOW (GET returns empty for unknown school)
 * - Schema has compound unique index {schoolId, name}
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  startSession: jest.fn().mockResolvedValue({
    withTransaction: jest.fn(async (fn) => fn()),
    endSession: jest.fn(),
  }),
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
}));

// The backend resolves `require('mongoose')` to its own copy
// (backend/node_modules/mongoose), which the jest.mock('mongoose') above (the
// root copy) does not intercept. Stub startSession on that instance so the
// transactional apply path uses a fake session instead of hanging on a real,
// disconnected one.
const backendMongoose = require('../backend/node_modules/mongoose');
backendMongoose.startSession = jest.fn().mockResolvedValue({
  withTransaction: async (fn) => fn(),
  endSession: jest.fn(),
});

jest.mock('../backend/src/models/sourceValidationRuleModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(),
}));
jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn(),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
}));
jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  findOne: jest.fn().mockResolvedValue(null),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/feeStructureModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/disputeModel', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(),
  findOneAndUpdate: jest.fn(), countDocuments: jest.fn(),
}));

// School mock: switch schoolId based on X-School-ID header
jest.mock('../backend/src/models/schoolModel', () => {
  const fn = jest.fn();
  fn.mockImplementation(() => ({
    lean: jest.fn(async function () {
      // We need access to the header — simulate by returning school based on most recent call
      const schoolId = fn._lastSchoolId || 'SCH001';
      return {
        schoolId, name: 'Test School', slug: schoolId.toLowerCase(),
        stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        localCurrency: 'USD', isActive: true,
      };
    }),
  }));
  fn._lastSchoolId = 'SCH001';
  return { findOne: fn, create: jest.fn().mockResolvedValue({}) };
});

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(), setupMonitoring: jest.fn(),
}));
jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));
jest.mock('../backend/src/services/transactionService', () => ({
  startPolling: jest.fn(), stopPolling: jest.fn(),
}));
jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
}));
jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(), stopReminderScheduler: jest.fn(),
  processReminders: jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
}));
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
  _getRates: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/feeAdjustmentService', () => ({
  calculateAdjustedFee: jest.fn(),
  simulateWithExtra: jest.fn(),
}));

// Mock the audit service so auth-failure / error paths don't await a real
// (disconnected) Mongo write and hang.
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue({}),
  getAuditLogs: jest.fn().mockResolvedValue([]),
  getRecentAuditLogs: jest.fn().mockResolvedValue([]),
  getAuditHealth: jest.fn().mockResolvedValue({}),
  verifyAuditChain: jest.fn().mockResolvedValue({}),
  archiveAuditLogs: jest.fn().mockResolvedValue({}),
  _resetAuditFailureCount: jest.fn(),
  _computeEntryHash: jest.fn(),
}));

const app = require('../backend/src/app');

// ── Helpers ───────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const ADMIN_TOKEN = jwt.sign({ role: 'admin', sub: 'admin-1' }, 'test-secret', { expiresIn: '1h' });

function adminApi(method, path, schoolId = 'SCH001') {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .set('X-School-ID', schoolId);
}

const RULE_SCH001 = {
  _id: '507f1f77bcf86cd799439011',
  schoolId: 'SCH001',
  name: 'block-bad-actor',
  type: 'blacklist',
  value: 'GBADACTOR00000000000000000000000000000000000000000000000000',
  isActive: true,
  priority: 10,
};

const RULE_SCH002 = {
  _id: '507f1f77bcf86cd799439022',
  schoolId: 'SCH002',
  name: 'block-bad-actor',  // same name — allowed because different school
  type: 'blacklist',
  value: 'GBADACTOR00000000000000000000000000000000000000000000000001',
  isActive: true,
  priority: 10,
};

// ── Tenant isolation: create ──────────────────────────────────────────────────

describe('#904 POST /api/source-rules — tenant isolation on create', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('stores schoolId from req.schoolId on created rule', async () => {
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(RULE_SCH001);

    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'block-bad-actor', type: 'blacklist',
      value: 'GBADACTOR00000000000000000000000000000000000000000000000000',
    });

    expect(res.status).toBe(201);
    expect(SourceValidationRule.create).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
  });

  test('duplicate check is scoped to this school only', async () => {
    // SCH002 has a rule with same name — SCH001 should NOT see a conflict
    SourceValidationRule.findOne.mockResolvedValueOnce(null); // no match for SCH001
    SourceValidationRule.create.mockResolvedValueOnce(RULE_SCH001);

    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'block-bad-actor', type: 'blacklist',
      value: 'GBADACTOR00000000000000000000000000000000000000000000000000',
    });

    expect(res.status).toBe(201);
    // findOne must include schoolId so it only checks THIS school
    expect(SourceValidationRule.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
  });

  test('409 within same school when name already exists', async () => {
    SourceValidationRule.findOne.mockResolvedValueOnce(RULE_SCH001); // conflict

    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'block-bad-actor', type: 'blacklist',
      value: 'GOTHER0000000000000000000000000000000000000000000000000000',
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('code', 'DUPLICATE_RULE');
  });

  test('400 — missing school context header returns MISSING_SCHOOL_CONTEXT', async () => {
    const res = await request(app)
      .post('/api/source-rules')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ name: 'test', type: 'blacklist', value: 'GXXX' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'MISSING_SCHOOL_CONTEXT');
  });
});

// ── Tenant isolation: list ────────────────────────────────────────────────────

describe('#904 GET /api/source-rules — tenant isolation on list', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('query includes schoolId — School A cannot see School B rules', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([RULE_SCH001]),
    });

    await adminApi('get', '/api/source-rules', 'SCH001');

    expect(SourceValidationRule.find).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
    // Must NOT be called with an empty filter (which would return all schools)
    expect(SourceValidationRule.find).not.toHaveBeenCalledWith({});
  });

  test('returns empty array for a school with no rules (unmatched-sender default: ALLOW)', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([]),
    });

    const res = await adminApi('get', '/api/source-rules', 'SCH999');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // An empty rule set means no senders are blocked — default is ALLOW
  });

  test('type filter is combined with schoolId scope', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([RULE_SCH001]),
    });

    await adminApi('get', '/api/source-rules?type=blacklist', 'SCH001');

    expect(SourceValidationRule.find).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001', type: 'blacklist' })
    );
  });
});

// ── Tenant isolation: delete ──────────────────────────────────────────────────

describe('#904 DELETE /api/source-rules/:id — tenant isolation on delete', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('delete query includes schoolId — prevents cross-tenant deletion', async () => {
    SourceValidationRule.findOneAndDelete.mockResolvedValueOnce(RULE_SCH001);

    await adminApi('delete', `/api/source-rules/${RULE_SCH001._id}`, 'SCH001');

    expect(SourceValidationRule.findOneAndDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: RULE_SCH001._id,
        schoolId: 'SCH001',
      })
    );
  });

  test('404 when trying to delete a rule that belongs to another school', async () => {
    // School B's rule ID queried from School A → returns null (tenant-scoped)
    SourceValidationRule.findOneAndDelete.mockResolvedValueOnce(null);

    const res = await adminApi('delete', `/api/source-rules/${RULE_SCH002._id}`, 'SCH001');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  test('200 — successfully deletes own rule', async () => {
    SourceValidationRule.findOneAndDelete.mockResolvedValueOnce(RULE_SCH001);

    const res = await adminApi('delete', `/api/source-rules/${RULE_SCH001._id}`, 'SCH001');

    expect(res.status).toBe(200);
    expect(res.body.message).toContain(RULE_SCH001.name);
  });
});

// ── Abuse / edge cases ────────────────────────────────────────────────────────

describe('#904 abuse and edge-case tests', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('401 — unauthenticated POST is rejected', async () => {
    const res = await request(app)
      .post('/api/source-rules')
      .set('X-School-ID', 'SCH001')
      .send({ name: 'x', type: 'blacklist', value: 'GXXX' });
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token cannot create rules', async () => {
    const userToken = jwt.sign({ role: 'user', sub: 'u1' }, 'test-secret', { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/source-rules')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-School-ID', 'SCH001')
      .send({ name: 'x', type: 'blacklist', value: 'GXXX' });
    expect(res.status).toBe(403);
  });

  test('401 — unauthenticated GET is rejected', async () => {
    const res = await request(app)
      .get('/api/source-rules')
      .set('X-School-ID', 'SCH001');
    expect(res.status).toBe(401);
  });

  test('400 — invalid type is rejected', async () => {
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'test', type: 'ALLOW_ALL',
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — blacklist without value is rejected', async () => {
    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'test', type: 'blacklist',
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — pattern with invalid regex is rejected', async () => {
    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'bad-regex', type: 'pattern', value: '[invalid',
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('201 — valid pattern with proper regex is accepted', async () => {
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce({
      ...RULE_SCH001, type: 'pattern', value: '^G[A-Z0-9]{55}$',
    });

    const res = await adminApi('post', '/api/source-rules', 'SCH001').send({
      name: 'stellar-address-pattern', type: 'pattern', value: '^G[A-Z0-9]{55}$',
    });
    expect(res.status).toBe(201);
  });
});
