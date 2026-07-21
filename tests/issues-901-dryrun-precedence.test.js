'use strict';

/**
 * Tests for Issue #901
 * - Deterministic rule precedence (priority ASC, name ASC as tiebreak)
 * - conflictResolutionPolicy field on model
 * - POST /api/fee-adjustments/dry-run endpoint
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');

// ── Model mocks ───────────────────────────────────────────────────────────────

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

jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn(),
  find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
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
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(),
  findOneAndUpdate: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../backend/src/models/sourceValidationRuleModel', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(),
  findOneAndDelete: jest.fn(), findByIdAndDelete: jest.fn(),
}));
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

// Mock feeAdjustmentService so we control dry-run behaviour independently
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

const jwt = require('jsonwebtoken');
const ADMIN_TOKEN = jwt.sign({ role: 'admin', sub: 'admin-1' }, 'test-secret', { expiresIn: '1h' });
const SCHOOL_HEADERS = { 'X-School-ID': 'SCH001' };

function adminApi(method, path) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .set(SCHOOL_HEADERS);
}

const MOCK_RULE = {
  _id: '507f1f77bcf86cd799439011',
  schoolId: 'SCH001',
  name: 'Early Bird',
  type: 'discount_percentage',
  value: 10,
  conditions: {},
  isActive: true,
  priority: 5,
  conflictResolutionPolicy: 'stack',
  description: '10% early discount',
};

// ── #901: conflictResolutionPolicy field ──────────────────────────────────────

describe('#901 POST /api/fee-adjustments — conflictResolutionPolicy', () => {
  let FeeAdjustmentRule;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    jest.clearAllMocks();
  });

  test('201 — stores stack policy by default', async () => {
    FeeAdjustmentRule.create.mockResolvedValueOnce({ ...MOCK_RULE, conflictResolutionPolicy: 'stack' });

    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Early Bird', type: 'discount_percentage', value: 10,
    });

    expect(res.status).toBe(201);
    expect(FeeAdjustmentRule.create).toHaveBeenCalledWith(
      expect.objectContaining({ conflictResolutionPolicy: 'stack' })
    );
  });

  test('201 — stores first_only policy when specified', async () => {
    FeeAdjustmentRule.create.mockResolvedValueOnce({
      ...MOCK_RULE, conflictResolutionPolicy: 'first_only',
    });

    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Early Bird', type: 'discount_percentage', value: 10,
      conflictResolutionPolicy: 'first_only',
    });

    expect(res.status).toBe(201);
    expect(FeeAdjustmentRule.create).toHaveBeenCalledWith(
      expect.objectContaining({ conflictResolutionPolicy: 'first_only' })
    );
  });

  test('201 — stores best_for_student policy when specified', async () => {
    FeeAdjustmentRule.create.mockResolvedValueOnce({
      ...MOCK_RULE, conflictResolutionPolicy: 'best_for_student',
    });

    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Early Bird', type: 'discount_percentage', value: 10,
      conflictResolutionPolicy: 'best_for_student',
    });

    expect(res.status).toBe(201);
  });

  test('400 — rejects unknown conflictResolutionPolicy', async () => {
    const res = await adminApi('post', '/api/fee-adjustments').send({
      name: 'Early Bird', type: 'discount_percentage', value: 10,
      conflictResolutionPolicy: 'unknown_policy',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});

// ── #901: GET list returns rules in deterministic priority order ───────────────

describe('#901 GET /api/fee-adjustments — deterministic priority order', () => {
  let FeeAdjustmentRule;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    jest.clearAllMocks();
  });

  test('sort is called with priority:1 then name:1', async () => {
    const mockSort = jest.fn().mockResolvedValueOnce([MOCK_RULE]);
    FeeAdjustmentRule.find.mockReturnValueOnce({ sort: mockSort });

    await request(app).get('/api/fee-adjustments').set(SCHOOL_HEADERS);

    expect(mockSort).toHaveBeenCalledWith({ priority: 1, name: 1 });
  });

  test('query is scoped to schoolId', async () => {
    FeeAdjustmentRule.find.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValueOnce([]),
    });

    await request(app).get('/api/fee-adjustments').set(SCHOOL_HEADERS);

    expect(FeeAdjustmentRule.find).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
  });
});

// ── #901: POST /api/fee-adjustments/dry-run ───────────────────────────────────

describe('#901 POST /api/fee-adjustments/dry-run', () => {
  let FeeAdjustmentRule, Student, feeAdjustmentService;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    Student = require('../backend/src/models/studentModel');
    feeAdjustmentService = require('../backend/src/services/feeAdjustmentService');
    jest.clearAllMocks();
  });

  const STUDENT = {
    _id: 'stu1', studentId: 'STU001', name: 'Alice', class: 'JSS1',
    feeAmount: 1000, totalPaid: 0, remainingBalance: 1000,
  };

  test('200 — returns dryRun:true with summary and per-student previews', async () => {
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([STUDENT]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValue({
      baseFee: 1000, finalFee: 1000, adjustmentsApplied: [],
    });
    feeAdjustmentService.simulateWithExtra.mockResolvedValue({
      baseFee: 1000, finalFee: 900, adjustmentsApplied: [{ ruleName: 'Test', type: 'discount_percentage', value: 10, amountAdjusted: 100 }],
      ruleApplied: true,
    });

    const res = await adminApi('post', '/api/fee-adjustments/dry-run').send({
      rule: { name: 'Test Discount', type: 'discount_percentage', value: 10 },
    });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary).toMatchObject({
      totalStudents: 1,
      affectedStudents: 1,
    });
    expect(res.body.previews).toHaveLength(1);
    expect(res.body.previews[0]).toMatchObject({
      studentId: 'STU001',
      currentFee: 1000,
      projectedFee: 900,
      delta: -100,
      ruleWouldApply: true,
    });
  });

  test('200 — flags overpaymentRisk when student already paid more than new fee', async () => {
    const paidStudent = { ...STUDENT, totalPaid: 950 };
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([paidStudent]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValue({
      baseFee: 1000, finalFee: 1000, adjustmentsApplied: [],
    });
    feeAdjustmentService.simulateWithExtra.mockResolvedValue({
      baseFee: 1000, finalFee: 900, adjustmentsApplied: [], ruleApplied: true,
    });

    const res = await adminApi('post', '/api/fee-adjustments/dry-run').send({
      rule: { type: 'discount_percentage', value: 10 },
    });

    expect(res.status).toBe(200);
    expect(res.body.summary.overpaymentRisks).toBe(1);
    expect(res.body.previews[0].overpaymentRisk).toBe(true);
  });

  test('200 — filters students by class when studentClass is provided', async () => {
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValue({ finalFee: 1000 });
    feeAdjustmentService.simulateWithExtra.mockResolvedValue({ finalFee: 1000, adjustmentsApplied: [], ruleApplied: false });

    const res = await adminApi('post', '/api/fee-adjustments/dry-run').send({
      rule: { type: 'discount_percentage', value: 10 },
      studentClass: 'JSS2',
    });

    expect(res.status).toBe(200);
    expect(Student.find).toHaveBeenCalledWith(
      expect.objectContaining({ class: 'JSS2' })
    );
  });

  test('400 — missing rule body returns VALIDATION_ERROR', async () => {
    const res = await adminApi('post', '/api/fee-adjustments/dry-run').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('400 — invalid rule type returns VALIDATION_ERROR', async () => {
    const res = await adminApi('post', '/api/fee-adjustments/dry-run').send({
      rule: { type: 'bad_type', value: 10 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('401 — unauthenticated request rejected', async () => {
    const res = await request(app)
      .post('/api/fee-adjustments/dry-run')
      .set(SCHOOL_HEADERS)
      .send({ rule: { type: 'discount_percentage', value: 10 } });
    expect(res.status).toBe(401);
  });

  test('400 — missing school header returns MISSING_SCHOOL_CONTEXT', async () => {
    const res = await request(app)
      .post('/api/fee-adjustments/dry-run')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ rule: { type: 'discount_percentage', value: 10 } });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'MISSING_SCHOOL_CONTEXT');
  });
});
