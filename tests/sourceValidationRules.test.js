'use strict';

// Must set required env vars before app is loaded
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/models/sourceValidationRuleModel', () => ({
  create:           jest.fn(),
  find:             jest.fn(),
  findOne:          jest.fn(),
  findOneAndDelete: jest.fn(),
}));

// Minimal stubs for models loaded transitively by app.js
jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn(), find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
  findOne: jest.fn().mockResolvedValue(null), findOneAndUpdate: jest.fn().mockResolvedValue({}), countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]), countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create: jest.fn().mockResolvedValue({}), findOne: jest.fn().mockResolvedValue(null), findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/feeStructureModel', () => ({
  create: jest.fn().mockResolvedValue({}), find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne: jest.fn().mockResolvedValue(null), findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null), findOneAndUpdate: jest.fn().mockResolvedValue({}), findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'SCH001', name: 'Test School', slug: 'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD', isActive: true,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/disputeModel', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(), setupMonitoring: jest.fn(),
}));
jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(), isRetryWorkerRunning: jest.fn().mockReturnValue(false),
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

const app = require('../backend/src/app');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// jsonwebtoken lives in backend/node_modules, resolved via jest moduleDirectories
const ADMIN_TOKEN = require('jsonwebtoken').sign({ role: 'admin', sub: 'admin-1' }, 'test-secret', { expiresIn: '1h' });
const USER_TOKEN  = require('jsonwebtoken').sign({ role: 'user',  sub: 'user-1'  }, 'test-secret', { expiresIn: '1h' });

function adminApi(method, path) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .set('X-School-ID', 'SCH001');
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_RULE = {
  _id:       '507f1f77bcf86cd799439011',
  name:      'block-suspicious-sender',
  type:      'blacklist',
  value:     'GBADACTOR000000000000000000000000000000000000000000000000',
  description: 'Known fraudulent address',
  isActive:  true,
  priority:  10,
  maxTransactionsPerDay: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ─── POST /api/source-rules ───────────────────────────────────────────────────

describe('POST /api/source-rules — create a rule', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('201 — creates a blacklist rule', async () => {
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('post', '/api/source-rules').send({
      name:  'block-suspicious-sender',
      type:  'blacklist',
      value: 'GBADACTOR000000000000000000000000000000000000000000000000',
      description: 'Known fraudulent address',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'block-suspicious-sender', type: 'blacklist' });
  });

  test('201 — creates a whitelist rule', async () => {
    const whitelistRule = { ...MOCK_RULE, name: 'trusted-sender', type: 'whitelist' };
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(whitelistRule);

    const res = await adminApi('post', '/api/source-rules').send({
      name:  'trusted-sender',
      type:  'whitelist',
      value: 'GTRUSTED0000000000000000000000000000000000000000000000000',
    });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('whitelist');
  });

  test('201 — creates a pattern rule with valid regex', async () => {
    const patternRule = { ...MOCK_RULE, name: 'pattern-rule', type: 'pattern', value: '^G[A-Z0-9]{55}$' };
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(patternRule);

    const res = await adminApi('post', '/api/source-rules').send({
      name:  'pattern-rule',
      type:  'pattern',
      value: '^G[A-Z0-9]{55}$',
    });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('pattern');
  });

  test('201 — creates a new_sender_limit rule', async () => {
    const limitRule = { ...MOCK_RULE, name: 'new-sender-cap', type: 'new_sender_limit', value: null, maxTransactionsPerDay: 3 };
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(limitRule);

    const res = await adminApi('post', '/api/source-rules').send({
      name:  'new-sender-cap',
      type:  'new_sender_limit',
      maxTransactionsPerDay: 3,
    });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('new_sender_limit');
  });

  test('400 — missing name', async () => {
    const res = await adminApi('post', '/api/source-rules').send({ type: 'blacklist', value: 'GXXX' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — missing type', async () => {
    const res = await adminApi('post', '/api/source-rules').send({ name: 'test', value: 'GXXX' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — invalid type value', async () => {
    const res = await adminApi('post', '/api/source-rules').send({ name: 'test', type: 'unknown', value: 'GXXX' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — blacklist without value', async () => {
    const res = await adminApi('post', '/api/source-rules').send({ name: 'test', type: 'blacklist' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — pattern with invalid regex', async () => {
    const res = await adminApi('post', '/api/source-rules').send({ name: 'bad-regex', type: 'pattern', value: '[invalid' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('409 — duplicate rule name', async () => {
    SourceValidationRule.findOne.mockResolvedValueOnce(MOCK_RULE); // already exists

    const res = await adminApi('post', '/api/source-rules').send({
      name:  'block-suspicious-sender',
      type:  'blacklist',
      value: 'GBADACTOR000000000000000000000000000000000000000000000000',
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('code', 'DUPLICATE_RULE');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).post('/api/source-rules')
      .set('X-School-ID', 'SCH001')
      .send({ name: 'test', type: 'blacklist', value: 'GXXX' });
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token is rejected', async () => {
    const res = await request(app).post('/api/source-rules')
      .set('X-School-ID', 'SCH001')
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .send({ name: 'test', type: 'blacklist', value: 'GXXX' });
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/source-rules ────────────────────────────────────────────────────

describe('GET /api/source-rules — list rules', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('200 — returns all rules', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([MOCK_RULE]),
    });

    const res = await adminApi('get', '/api/source-rules');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ name: 'block-suspicious-sender', type: 'blacklist' });
  });

  test('200 — returns empty array when no rules exist', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([]),
    });

    const res = await adminApi('get', '/api/source-rules');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  test('200 — supports filtering by type', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([MOCK_RULE]),
    });

    const res = await adminApi('get', '/api/source-rules?type=blacklist');

    expect(res.status).toBe(200);
    expect(SourceValidationRule.find).toHaveBeenCalledWith(expect.objectContaining({ type: 'blacklist' }));
  });

  test('200 — supports filtering by isActive', async () => {
    SourceValidationRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([MOCK_RULE]),
    });

    const res = await adminApi('get', '/api/source-rules?isActive=true');

    expect(res.status).toBe(200);
    expect(SourceValidationRule.find).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/source-rules').set('X-School-ID', 'SCH001');
    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/source-rules/:id ────────────────────────────────────────────

describe('DELETE /api/source-rules/:id — delete a rule', () => {
  let SourceValidationRule;

  beforeEach(() => {
    SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    jest.clearAllMocks();
  });

  test('200 — deletes an existing rule', async () => {
    SourceValidationRule.findOneAndDelete.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('delete', `/api/source-rules/${MOCK_RULE._id}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message');
    expect(res.body.message).toContain(MOCK_RULE.name);
  });

  test('404 — rule not found', async () => {
    SourceValidationRule.findOneAndDelete.mockResolvedValueOnce(null);

    const res = await adminApi('delete', '/api/source-rules/000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).delete(`/api/source-rules/${MOCK_RULE._id}`)
      .set('X-School-ID', 'SCH001');
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token is rejected', async () => {
    const res = await request(app).delete(`/api/source-rules/${MOCK_RULE._id}`)
      .set('X-School-ID', 'SCH001')
      .set('Authorization', `Bearer ${USER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});
