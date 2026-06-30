'use strict';

/**
 * #886 — Audit coverage for mutating actions.
 *
 * Verifies that logAudit is called with the correct action, actor, targetType,
 * and before/after details for:
 *   - dispute flagging (flagDispute)
 *   - dispute resolution (resolveDispute)
 *   - fee adjustment rule create / update / delete
 *   - source validation rule create / delete
 *   - webhook DLQ retry (retryDLQEntry)
 */

// ── Env ───────────────────────────────────────────────────────────────────────

process.env.MONGO_URI            = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET           = 'test-secret';

// ── Audit spy (must be hoisted before app loads) ──────────────────────────────

const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:              (...args) => mockLogAudit(...args),
  getAuditHealth:        jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
  getAuditLogs:          jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getRecentAuditLogs:    jest.fn().mockResolvedValue([]),
  verifyAuditChain:      jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  archiveAuditLogs:      jest.fn().mockResolvedValue(0),
  _resetAuditFailureCount: jest.fn(),
}));

// ── Mongoose stub ─────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

// ── Model stubs ───────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/disputeModel', () => ({
  create:           jest.fn(),
  find:             jest.fn(),
  findOne:          jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments:   jest.fn(),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find:          jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne:       jest.fn().mockResolvedValue(null),
  create:        jest.fn().mockResolvedValue({}),
  aggregate:     jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/systemConfigModel', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => {
  // findOne needs to support .lean() chaining
  const mockFindOne = jest.fn();
  mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  return {
    create:           jest.fn(),
    find:             jest.fn(),
    findOne:          mockFindOne,
    findOneAndUpdate: jest.fn(),
  };
});

jest.mock('../backend/src/models/sourceValidationRuleModel', () => ({
  create:            jest.fn(),
  find:              jest.fn(),
  findOne:           jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../backend/src/models/webhookRetryModel', () => ({
  find:        jest.fn(),
  findById:    jest.fn(),
  updateOne:   jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create:           jest.fn().mockResolvedValue({}),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments:   jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create:            jest.fn().mockResolvedValue({}),
  findOne:           jest.fn().mockResolvedValue(null),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/idempotencyKeyModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create:  jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  create:           jest.fn().mockResolvedValue({}),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find:              jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOne:           jest.fn().mockResolvedValue(null),
  findOneAndUpdate:  jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId:       'SCH001',
      name:           'Test School',
      slug:           'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency:  'USD',
      isActive:       true,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));

// ── Service stubs ─────────────────────────────────────────────────────────────

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(),
  setupMonitoring:      jest.fn(),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry:        jest.fn().mockResolvedValue(undefined),
  startRetryWorker:     jest.fn(),
  stopRetryWorker:      jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/transactionService', () => ({
  startPolling: jest.fn(),
  stopPolling:  jest.fn(),
}));

jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(),
  stopReminderScheduler:  jest.fn(),
  processReminders:       jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
}));

jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments:              jest.fn().mockResolvedValue(undefined),
  syncPaymentsForSchool:     jest.fn().mockResolvedValue(undefined),
  verifyTransaction:         jest.fn().mockResolvedValue({}),
  recordPayment:             jest.fn().mockResolvedValue({}),
  finalizeConfirmedPayments: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/currencyConversionService', () => ({
  convertToLocalCurrency:      jest.fn().mockResolvedValue({ available: false }),
  enrichPaymentWithConversion: jest.fn().mockImplementation((p) => Promise.resolve(p)),
  _getRates:                   jest.fn().mockResolvedValue(null),
}));

// ── App + helpers ─────────────────────────────────────────────────────────────

const request    = require('supertest');
const app        = require('../backend/src/app');
const jwt        = require('jsonwebtoken');

const ADMIN_TOKEN = jwt.sign({ role: 'admin', sub: 'admin-1', email: 'admin@test.com' }, 'test-secret', { expiresIn: '1h' });

/** Issue a request with admin JWT and school context header. */
function adminApi(method, path) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .set('X-School-ID', 'SCH001');
}

beforeEach(() => {
  jest.clearAllMocks();
  // Restore audit spy default
  mockLogAudit.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// DISPUTE — flagDispute
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — flagDispute', () => {
  const MOCK_PAYMENT = {
    _id: '507f1f77bcf86cd799439011', schoolId: 'SCH001',
    txHash: 'a'.repeat(64), studentId: 'STU001', amount: 200, status: 'SUCCESS',
  };

  const MOCK_DISPUTE = {
    _id: '607f1f77bcf86cd799439022', schoolId: 'SCH001',
    txHash: 'a'.repeat(64), studentId: 'STU001',
    raisedBy: 'Alice Parent', reason: 'Already paid', status: 'open',
  };

  test('emits audit entry with action=dispute_flag on success', async () => {
    const Payment = require('../backend/src/models/paymentModel');
    const Dispute  = require('../backend/src/models/disputeModel');
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);

    const res = await request(app).post('/api/disputes')
      .set('X-School-ID', 'SCH001')
      .send({ txHash: MOCK_PAYMENT.txHash, studentId: 'STU001', raisedBy: 'Alice Parent', reason: 'Already paid' });

    expect(res.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'dispute_flag',
        targetType: 'dispute',
        details:    expect.objectContaining({ txHash: MOCK_PAYMENT.txHash, studentId: 'STU001' }),
      })
    );
  });

  test('does NOT emit audit entry when payment is not found (no side-effect on failure)', async () => {
    const Payment = require('../backend/src/models/paymentModel');
    Payment.findOne.mockResolvedValueOnce(null);

    const res = await request(app).post('/api/disputes')
      .set('X-School-ID', 'SCH001')
      .send({ txHash: MOCK_PAYMENT.txHash, studentId: 'STU001', raisedBy: 'Alice', reason: 'test' });

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DISPUTE — resolveDispute
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — resolveDispute', () => {
  const DISPUTE_ID   = '607f1f77bcf86cd799439022';
  const RESOLVED     = {
    _id: DISPUTE_ID, schoolId: 'SCH001', txHash: 'a'.repeat(64), studentId: 'STU001',
    status: 'resolved', resolvedBy: 'admin@test.com', resolutionNote: 'Verified and closed',
    resolvedAt: new Date().toISOString(),
  };

  test('emits audit entry with action=dispute_resolve and before/after details', async () => {
    const Dispute = require('../backend/src/models/disputeModel');
    Dispute.findOneAndUpdate.mockResolvedValueOnce(RESOLVED);

    const res = await adminApi('patch', `/api/disputes/${DISPUTE_ID}/resolve`)
      .send({ resolutionNote: 'Verified and closed', status: 'resolved' });

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'dispute_resolve',
        targetType: 'dispute',
        targetId:   DISPUTE_ID,
        details:    expect.objectContaining({
          newStatus:      'resolved',
          resolutionNote: 'Verified and closed',
        }),
      })
    );
  });

  test('captures resolvedBy from the JWT actor', async () => {
    const Dispute = require('../backend/src/models/disputeModel');
    Dispute.findOneAndUpdate.mockResolvedValueOnce(RESOLVED);

    await adminApi('patch', `/api/disputes/${DISPUTE_ID}/resolve`)
      .send({ resolutionNote: 'Done' });

    const call = mockLogAudit.mock.calls[0][0];
    expect(call.details).toHaveProperty('resolvedBy');
    expect(typeof call.details.resolvedBy).toBe('string');
    expect(call.details.resolvedBy.length).toBeGreaterThan(0);
  });

  test('does NOT emit audit when dispute is not found', async () => {
    const Dispute = require('../backend/src/models/disputeModel');
    Dispute.findOneAndUpdate.mockResolvedValueOnce(null);

    const res = await adminApi('patch', `/api/disputes/${DISPUTE_ID}/resolve`)
      .send({ resolutionNote: 'Nothing' });

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('includes schoolId in audit entry', async () => {
    const Dispute = require('../backend/src/models/disputeModel');
    Dispute.findOneAndUpdate.mockResolvedValueOnce(RESOLVED);

    await adminApi('patch', `/api/disputes/${DISPUTE_ID}/resolve`)
      .send({ resolutionNote: 'Done' });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEE ADJUSTMENT RULE — createRule
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — fee adjustment createRule', () => {
  const MOCK_RULE = {
    _id: '507f1f77bcf86cd799439033', schoolId: 'SCH001',
    name: 'Early Bird Discount', type: 'discount_percentage', value: 10,
    conditions: {}, priority: 10, isActive: true,
  };

  test('emits audit entry with action=fee_adjustment_rule_create on success', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.create.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('post', '/api/fee-adjustments')
      .send({ name: 'Early Bird Discount', type: 'discount_percentage', value: 10 });

    expect(res.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'fee_adjustment_rule_create',
        targetType: 'fee_adjustment_rule',
        targetId:   MOCK_RULE._id,
        details:    expect.objectContaining({ name: 'Early Bird Discount', type: 'discount_percentage', value: 10 }),
      })
    );
  });

  test('includes schoolId and performedBy in audit entry', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.create.mockResolvedValueOnce(MOCK_RULE);

    await adminApi('post', '/api/fee-adjustments')
      .send({ name: 'Early Bird Discount', type: 'discount_percentage', value: 10 });

    const call = mockLogAudit.mock.calls[0][0];
    expect(call.schoolId).toBe('SCH001');
    expect(typeof call.performedBy).toBe('string');
    expect(call.performedBy.length).toBeGreaterThan(0);
  });

  test('does NOT emit audit on validation failure', async () => {
    const res = await adminApi('post', '/api/fee-adjustments')
      .send({ type: 'discount_percentage', value: 10 }); // missing name

    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEE ADJUSTMENT RULE — updateRule
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — fee adjustment updateRule', () => {
  const RULE_ID   = '507f1f77bcf86cd799439033';
  const BEFORE    = { _id: RULE_ID, schoolId: 'SCH001', name: 'Old Name', type: 'discount_percentage', value: 5,  isActive: true };
  const AFTER     = { _id: RULE_ID, schoolId: 'SCH001', name: 'New Name', type: 'discount_percentage', value: 15, isActive: true };

  test('emits audit entry with action=fee_adjustment_rule_update and before/after', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    // findOne for before-state capture, findOneAndUpdate returns updated doc
    FeeAdjustmentRule.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce(BEFORE) });
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(AFTER);

    const res = await adminApi('put', `/api/fee-adjustments/${RULE_ID}`)
      .send({ name: 'New Name', type: 'discount_percentage', value: 15 });

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'fee_adjustment_rule_update',
        targetType: 'fee_adjustment_rule',
        targetId:   RULE_ID,
        details:    expect.objectContaining({
          before: expect.objectContaining({ name: 'Old Name', value: 5  }),
          after:  expect.objectContaining({ name: 'New Name', value: 15 }),
        }),
      })
    );
  });

  test('does NOT emit audit when rule is not found', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce(null) });
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(null);

    const res = await adminApi('put', `/api/fee-adjustments/${RULE_ID}`)
      .send({ name: 'X', type: 'discount_percentage', value: 10 });

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('before is null when pre-fetch finds nothing (rule was deleted between requests)', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce(null) }); // pre-fetch misses
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(AFTER);

    await adminApi('put', `/api/fee-adjustments/${RULE_ID}`)
      .send({ name: 'New Name', type: 'discount_percentage', value: 15 });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ before: null }),
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEE ADJUSTMENT RULE — deleteRule
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — fee adjustment deleteRule', () => {
  const RULE_ID = '507f1f77bcf86cd799439033';
  const MOCK_RULE = {
    _id: RULE_ID, schoolId: 'SCH001',
    name: 'Early Bird Discount', type: 'discount_percentage', value: 10, isActive: false,
  };

  test('emits audit entry with action=fee_adjustment_rule_delete on success', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('delete', `/api/fee-adjustments/${RULE_ID}`);

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'fee_adjustment_rule_delete',
        targetType: 'fee_adjustment_rule',
        targetId:   RULE_ID,
        details:    expect.objectContaining({ name: 'Early Bird Discount' }),
      })
    );
  });

  test('does NOT emit audit when rule is not found', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(null);

    const res = await adminApi('delete', `/api/fee-adjustments/${RULE_ID}`);

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('includes schoolId in the audit entry', async () => {
    const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
    FeeAdjustmentRule.findOneAndUpdate.mockResolvedValueOnce(MOCK_RULE);

    await adminApi('delete', `/api/fee-adjustments/${RULE_ID}`);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH001' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE VALIDATION RULE — createRule
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — source validation createRule', () => {
  const MOCK_RULE = {
    _id:       '507f1f77bcf86cd799439044',
    name:      'block-bad-actor',
    type:      'blacklist',
    value:     'GBADACTOR000000000000000000000000000000000000000000000000',
    isActive:  true,
    priority:  10,
    maxTransactionsPerDay: null,
  };

  test('emits audit entry with action=source_validation_rule_create on success', async () => {
    const SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('post', '/api/source-rules')
      .send({ name: 'block-bad-actor', type: 'blacklist', value: 'GBADACTOR000000000000000000000000000000000000000000000000' });

    expect(res.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'source_validation_rule_create',
        targetType: 'source_validation_rule',
        targetId:   MOCK_RULE._id,
        details:    expect.objectContaining({ name: 'block-bad-actor', type: 'blacklist' }),
      })
    );
  });

  test('uses schoolId="system" since rules are global (not per-school)', async () => {
    const SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    SourceValidationRule.findOne.mockResolvedValueOnce(null);
    SourceValidationRule.create.mockResolvedValueOnce(MOCK_RULE);

    await adminApi('post', '/api/source-rules')
      .send({ name: 'block-bad-actor', type: 'blacklist', value: 'GBADACTOR000000000000000000000000000000000000000000000000' });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'system' })
    );
  });

  test('does NOT emit audit on validation failure (missing name)', async () => {
    const res = await adminApi('post', '/api/source-rules')
      .send({ type: 'blacklist', value: 'GXXX' });

    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('does NOT emit audit on duplicate rule name', async () => {
    const SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    SourceValidationRule.findOne.mockResolvedValueOnce(MOCK_RULE); // already exists

    const res = await adminApi('post', '/api/source-rules')
      .send({ name: 'block-bad-actor', type: 'blacklist', value: 'GBADACTOR000000000000000000000000000000000000000000000000' });

    expect(res.status).toBe(409);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE VALIDATION RULE — deleteRule
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — source validation deleteRule', () => {
  const RULE_ID  = '507f1f77bcf86cd799439044';
  const MOCK_RULE = {
    _id: RULE_ID, name: 'block-bad-actor', type: 'blacklist',
    value: 'GBADACTOR000000000000000000000000000000000000000000000000',
  };

  test('emits audit entry with action=source_validation_rule_delete on success', async () => {
    const SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    SourceValidationRule.findByIdAndDelete.mockResolvedValueOnce(MOCK_RULE);

    const res = await adminApi('delete', `/api/source-rules/${RULE_ID}`);

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'source_validation_rule_delete',
        targetType: 'source_validation_rule',
        targetId:   RULE_ID,
        details:    expect.objectContaining({ name: 'block-bad-actor', type: 'blacklist' }),
      })
    );
  });

  test('uses schoolId="system" for global rule deletion', async () => {
    const SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    SourceValidationRule.findByIdAndDelete.mockResolvedValueOnce(MOCK_RULE);

    await adminApi('delete', `/api/source-rules/${RULE_ID}`);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'system' })
    );
  });

  test('does NOT emit audit when rule is not found', async () => {
    const SourceValidationRule = require('../backend/src/models/sourceValidationRuleModel');
    SourceValidationRule.findByIdAndDelete.mockResolvedValueOnce(null);

    const res = await adminApi('delete', `/api/source-rules/${RULE_ID}`);

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK DLQ — retryDLQEntry
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit — webhook DLQ retryDLQEntry', () => {
  const ENTRY_ID = '507f1f77bcf86cd799439055';
  const MOCK_ENTRY = {
    _id:          ENTRY_ID,
    deliveryId:   'dlv-abc123',
    url:          'https://school.example.com/webhook',
    event:        'payment.confirmed',
    payload:      { studentId: 'STU001' },
    status:       'failed',
    attemptCount: 5,
  };

  test('emits audit entry with action=webhook_dlq_retry on success', async () => {
    const WebhookRetry = require('../backend/src/models/webhookRetryModel');
    WebhookRetry.findById.mockResolvedValueOnce(MOCK_ENTRY);
    WebhookRetry.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    const res = await adminApi('post', `/api/admin/webhooks/dlq/${ENTRY_ID}/retry`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, deliveryId: 'dlv-abc123' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     'webhook_dlq_retry',
        targetType: 'webhook',
        targetId:   ENTRY_ID,
        details:    expect.objectContaining({
          deliveryId:          'dlv-abc123',
          url:                 'https://school.example.com/webhook',
          event:               'payment.confirmed',
          previousAttemptCount: 5,
        }),
      })
    );
  });

  test('uses schoolId="system" since webhook retries are not school-scoped', async () => {
    const WebhookRetry = require('../backend/src/models/webhookRetryModel');
    WebhookRetry.findById.mockResolvedValueOnce(MOCK_ENTRY);
    WebhookRetry.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    await adminApi('post', `/api/admin/webhooks/dlq/${ENTRY_ID}/retry`);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'system' })
    );
  });

  test('does NOT emit audit when entry is not found', async () => {
    const WebhookRetry = require('../backend/src/models/webhookRetryModel');
    WebhookRetry.findById.mockResolvedValueOnce(null);

    const res = await adminApi('post', `/api/admin/webhooks/dlq/${ENTRY_ID}/retry`);

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('does NOT emit audit when entry is not in failed state', async () => {
    const WebhookRetry = require('../backend/src/models/webhookRetryModel');
    WebhookRetry.findById.mockResolvedValueOnce({ ...MOCK_ENTRY, status: 'pending' });

    const res = await adminApi('post', `/api/admin/webhooks/dlq/${ENTRY_ID}/retry`);

    expect(res.status).toBe(409);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('captures performedBy from admin JWT in the audit entry', async () => {
    const WebhookRetry = require('../backend/src/models/webhookRetryModel');
    WebhookRetry.findById.mockResolvedValueOnce(MOCK_ENTRY);
    WebhookRetry.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    await adminApi('post', `/api/admin/webhooks/dlq/${ENTRY_ID}/retry`);

    const call = mockLogAudit.mock.calls[0][0];
    expect(typeof call.performedBy).toBe('string');
    expect(call.performedBy.length).toBeGreaterThan(0);
    expect(call.performedBy).not.toBe('unknown');
  });

  test('requires admin auth', async () => {
    const res = await request(app).post(`/api/admin/webhooks/dlq/${ENTRY_ID}/retry`);
    expect(res.status).toBe(401);
    // The auth middleware may emit its own auth_failure audit — confirm no webhook_dlq_retry audit
    const retryAuditCalls = mockLogAudit.mock.calls.filter(
      ([args]) => args && args.action === 'webhook_dlq_retry'
    );
    expect(retryAuditCalls).toHaveLength(0);
  });
});
