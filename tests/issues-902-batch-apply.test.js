'use strict';

/**
 * Tests for Issue #902
 * - POST /api/fee-adjustments/:id/apply
 * - Uses bulkWrite inside a MongoDB session
 * - Progress/status record returned
 * - Atomic: reports overpayments, skipped students, errors
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');

// ── Session mock ──────────────────────────────────────────────────────────────

const mockWithTransaction = jest.fn(async (fn) => fn());
const mockEndSession = jest.fn();

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  startSession: jest.fn().mockResolvedValue({
    withTransaction: mockWithTransaction,
    endSession: mockEndSession,
  }),
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
}));

// The backend resolves `require('mongoose')` to its own copy
// (backend/node_modules/mongoose), which the jest.mock('mongoose') above (the
// root copy) does not intercept. Stub startSession on that instance so the
// transactional apply path uses a fake session instead of hanging on — and
// then throwing from — a real, disconnected one.
const backendMongoose = require('../backend/node_modules/mongoose');
backendMongoose.startSession = jest.fn().mockResolvedValue({
  withTransaction: mockWithTransaction,
  endSession: mockEndSession,
});

// ── Model mocks ───────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
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
  findByIdAndDelete: jest.fn().mockResolvedValue({}),
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

const RULE_ID = '507f1f77bcf86cd799439011';

const MOCK_RULE = {
  _id: RULE_ID,
  schoolId: 'SCH001',
  name: 'JSS1 Discount',
  type: 'discount_percentage',
  value: 10,
  conditions: { studentClass: ['JSS1'] },
  isActive: true,
  priority: 5,
  conflictResolutionPolicy: 'stack',
};

const STUDENT_JSS1 = {
  _id: 'stu1', studentId: 'STU001', name: 'Alice', class: 'JSS1',
  schoolId: 'SCH001', feeAmount: 1000, totalPaid: 0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#902 POST /api/fee-adjustments/:id/apply', () => {
  let FeeAdjustmentRule, Student, feeAdjustmentService;

  beforeEach(() => {
    FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    Student = require('../backend/src/models/studentModel');
    feeAdjustmentService = require('../backend/src/services/feeAdjustmentService');
    jest.clearAllMocks();
    mockWithTransaction.mockImplementation(async (fn) => fn());
  });

  test('200 — applies rule, calls bulkWrite, returns completed status', async () => {
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([STUDENT_JSS1]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValueOnce({
      baseFee: 1000, finalFee: 900, adjustmentsApplied: [],
    });

    const res = await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.studentsUpdated).toBe(1);
    expect(Student.bulkWrite).toHaveBeenCalledTimes(1);
    // Confirm bulkWrite received an updateOne op
    const ops = Student.bulkWrite.mock.calls[0][0];
    expect(ops[0]).toHaveProperty('updateOne');
    expect(ops[0].updateOne.update.$set.feeAmount).toBe(900);
  });

  test('200 — uses a MongoDB session (withTransaction called)', async () => {
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([STUDENT_JSS1]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValueOnce({
      baseFee: 1000, finalFee: 900, adjustmentsApplied: [],
    });

    await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  test('200 — skips student when fee is unchanged', async () => {
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([STUDENT_JSS1]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValueOnce({
      baseFee: 1000, finalFee: 1000, adjustmentsApplied: [],
    });

    const res = await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    expect(res.status).toBe(200);
    expect(res.body.studentsSkipped).toBe(1);
    expect(res.body.studentsUpdated).toBe(0);
    expect(Student.bulkWrite).not.toHaveBeenCalled();
  });

  test('200 — detects overpayment when totalPaid > new fee', async () => {
    const paidStudent = { ...STUDENT_JSS1, totalPaid: 950 };
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([paidStudent]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValueOnce({
      baseFee: 1000, finalFee: 800, adjustmentsApplied: [],
    });

    const res = await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    expect(res.status).toBe(200);
    expect(res.body.overpaymentCount).toBe(1);
    expect(res.body.overpayments[0]).toMatchObject({
      studentId: 'STU001',
      newFee: 800,
      amountPaid: 950,
      creditAmount: 150,
    });
  });

  test('200 — remainingBalance clamped to 0 for overpaid students', async () => {
    const paidStudent = { ...STUDENT_JSS1, totalPaid: 950 };
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([paidStudent]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValueOnce({
      baseFee: 1000, finalFee: 800, adjustmentsApplied: [],
    });

    await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    const ops = Student.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.remainingBalance).toBe(0);
  });

  test('200 — response includes progress fields', async () => {
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([STUDENT_JSS1]) });
    feeAdjustmentService.calculateAdjustedFee.mockResolvedValueOnce({
      baseFee: 1000, finalFee: 900, adjustmentsApplied: [],
    });

    const res = await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    expect(res.body).toMatchObject({
      status: 'completed',
      ruleId: RULE_ID,
      ruleName: 'JSS1 Discount',
      studentsProcessed: expect.any(Number),
      studentsUpdated: expect.any(Number),
      studentsSkipped: expect.any(Number),
    });
  });

  test('404 — rule not found returns NOT_FOUND', async () => {
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(null);

    const res = await adminApi('post', '/api/fee-adjustments/000000000000000000000000/apply').send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
  });

  test('401 — unauthenticated request rejected', async () => {
    const res = await request(app)
      .post(`/api/fee-adjustments/${RULE_ID}/apply`)
      .set(SCHOOL_HEADERS)
      .send({});
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token rejected', async () => {
    const userToken = jwt.sign({ role: 'user', sub: 'u1' }, 'test-secret', { expiresIn: '1h' });
    const res = await request(app)
      .post(`/api/fee-adjustments/${RULE_ID}/apply`)
      .set('Authorization', `Bearer ${userToken}`)
      .set(SCHOOL_HEADERS)
      .send({});
    expect(res.status).toBe(403);
  });

  test('200 — scopes student query to schoolId', async () => {
    FeeAdjustmentRule.findOne.mockResolvedValueOnce(MOCK_RULE);
    Student.find.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue([]) });

    await adminApi('post', `/api/fee-adjustments/${RULE_ID}/apply`).send({});

    expect(Student.find).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
  });
});
