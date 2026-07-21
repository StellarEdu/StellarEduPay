'use strict';

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

jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => ({
  create:            jest.fn(),
  find:              jest.fn(),
  findOne:           jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  findOneAndUpdate:  jest.fn(),
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
// The controller (and auth failure path) await logAudit, which writes to the real
// AuditLog model — with no DB it never resolves and the request hangs to timeout.
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const app = require('../backend/src/app');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const ADMIN_TOKEN = jwt.sign({ role: 'admin', sub: 'admin-1' }, 'test-secret', { expiresIn: '1h' });
const USER_TOKEN  = jwt.sign({ role: 'user',  sub: 'user-1'  }, 'test-secret', { expiresIn: '1h' });

const SCHOOL_HEADERS = { 'X-School-ID': 'SCH001' };

function adminApi(method, path) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .set(SCHOOL_HEADERS);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_RULE = {
  _id:       '507f1f77bcf86cd799439011',
  schoolId:  'SCH001',
  name:      'Early Bird Discount',
  type:      'discount_percentage',
  value:     10,
  conditions: { studentClass: ['JSS1'], paymentBefore: '2026-09-01T00:00:00.000Z' },
  isActive:  true,
  priority:  5,
  description: '10% discount for early payment',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ─── POST /api/fee-adjustments ────────────────────────────────────────────────

describe('POST /api/fee-adjustments — create a rule', () => {
  let FeeAdjustmentRule;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    jest.clearAllMocks();
  });

  test('201 — creates a discount_percentage rule', async () => {
    FeeAdjustmentRule.create.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Early Bird Discount',
      type: 'discount_percentage',
      value: 10,
      conditions: { studentClass: ['JSS1'] },
      priority: 5,
      description: '10% discount for early payment',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Early Bird Discount', type: 'discount_percentage', value: 10 });
  });

  test('201 — creates a waiver rule', async () => {
    const waiverRule = { ...MOCK_RULE, name: 'Full Waiver', type: 'waiver', value: 0 };
    FeeAdjustmentRule.create.mockResolvedValueOnce(waiverRule);

    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Full Waiver', type: 'waiver', value: 0,
    });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('waiver');
  });

  test('400 — missing name', async () => {
    const res = await adminApi('post', '/api/fee-adjustments').send({ type: 'discount_percentage', value: 10 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty(['error', 'code'], 'VALIDATION_ERROR');
  });

  test('400 — missing type', async () => {
    const res = await adminApi('post', '/api/fee-adjustments').send({ name: 'Test', value: 10 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty(['error', 'code'], 'VALIDATION_ERROR');
  });

  test('400 — invalid type value', async () => {
    const res = await adminApi('post', '/api/fee-adjustments').send({ name: 'Test', type: 'invalid_type', value: 10 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty(['error', 'code'], 'VALIDATION_ERROR');
  });

  test('400 — negative value', async () => {
    const res = await adminApi('post', '/api/fee-adjustments').send({ name: 'Test', type: 'discount_fixed', value: -5 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty(['error', 'code'], 'VALIDATION_ERROR');
  });

  test('409 — duplicate rule name for same school', async () => {
    const dupError = new Error('duplicate key');
    dupError.code = 11000;
    FeeAdjustmentRule.create.mockRejectedValueOnce(dupError);

    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Early Bird Discount', type: 'discount_percentage', value: 10,
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty(['error', 'code'], 'DUPLICATE_RULE');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).post('/api/fee-adjustments')
      .set(SCHOOL_HEADERS)
      .send({ name: 'Test', type: 'discount_percentage', value: 10 });
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token is rejected', async () => {
    const res = await request(app).post('/api/fee-adjustments')
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .set(SCHOOL_HEADERS)
      .send({ name: 'Test', type: 'discount_percentage', value: 10 });
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/fee-adjustments ─────────────────────────────────────────────────

describe('GET /api/fee-adjustments — list rules', () => {
  let FeeAdjustmentRule;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    jest.clearAllMocks();
  });

  test('200 — returns all rules for the school', async () => {
    FeeAdjustmentRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([MOCK_RULE]),
    });

    const res = await request(app).get('/api/fee-adjustments').set(SCHOOL_HEADERS);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ name: 'Early Bird Discount', schoolId: 'SCH001' });
  });

  test('200 — returns empty array when no rules exist', async () => {
    FeeAdjustmentRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([]),
    });

    const res = await request(app).get('/api/fee-adjustments').set(SCHOOL_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  test('200 — scopes query to the resolved school', async () => {
    FeeAdjustmentRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([MOCK_RULE]),
    });

    await request(app).get('/api/fee-adjustments').set(SCHOOL_HEADERS);

    expect(FeeAdjustmentRule.find).toHaveBeenCalledWith(expect.objectContaining({ schoolId: 'SCH001' }));
  });

  test('400 — missing school context header', async () => {
    const res = await request(app).get('/api/fee-adjustments');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'MISSING_SCHOOL_CONTEXT');
  });
});

// ─── PUT /api/fee-adjustments/:id ─────────────────────────────────────────────

describe('PUT /api/fee-adjustments/:id — update a rule', () => {
  let FeeAdjustmentRule;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    jest.clearAllMocks();
  });

  test('200 — updates an existing rule', async () => {
    const updated = { ...MOCK_RULE, value: 15, description: 'Updated discount' };
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(updated);

    const res = await adminApi('put', `/api/fee-adjustments/${MOCK_RULE._id}`).send({
      name: 'Early Bird Discount', type: 'discount_percentage', value: 15, description: 'Updated discount',
    });

    expect(res.status).toBe(200);
    expect(res.body.value).toBe(15);
  });

  test('404 — rule not found', async () => {
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(null);

    const res = await adminApi('put', '/api/fee-adjustments/000000000000000000000000').send({
      name: 'Nonexistent', type: 'discount_fixed', value: 50,
    });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty(['error', 'code'], 'NOT_FOUND');
  });

  test('400 — invalid body on update', async () => {
    const res = await adminApi('put', `/api/fee-adjustments/${MOCK_RULE._id}`).send({
      name: 'Test', type: 'bad_type', value: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty(['error', 'code'], 'VALIDATION_ERROR');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).put(`/api/fee-adjustments/${MOCK_RULE._id}`)
      .set(SCHOOL_HEADERS)
      .send({ name: 'Test', type: 'discount_percentage', value: 10 });
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token is rejected', async () => {
    const res = await request(app).put(`/api/fee-adjustments/${MOCK_RULE._id}`)
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .set(SCHOOL_HEADERS)
      .send({ name: 'Test', type: 'discount_percentage', value: 10 });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /api/fee-adjustments/:id ─────────────────────────────────────────

describe('DELETE /api/fee-adjustments/:id — deactivate a rule', () => {
  let FeeAdjustmentRule;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    jest.clearAllMocks();
  });

  test('200 — deactivates an existing rule', async () => {
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce({ ...MOCK_RULE, isActive: false });

    const res = await adminApi('delete', `/api/fee-adjustments/${MOCK_RULE._id}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Early Bird Discount');
    expect(FeeAdjustmentRule.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: MOCK_RULE._id }),
      { isActive: false },
      { new: true }
    );
  });

  test('404 — rule not found', async () => {
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(null);

    const res = await adminApi('delete', '/api/fee-adjustments/000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty(['error', 'code'], 'NOT_FOUND');
  });

  test('401 — unauthenticated request is rejected', async () => {
    const res = await request(app).delete(`/api/fee-adjustments/${MOCK_RULE._id}`).set(SCHOOL_HEADERS);
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token is rejected', async () => {
    const res = await request(app).delete(`/api/fee-adjustments/${MOCK_RULE._id}`)
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .set(SCHOOL_HEADERS);
    expect(res.status).toBe(403);
  });
});
