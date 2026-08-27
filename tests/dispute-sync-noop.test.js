'use strict';

/**
 * Regression tests for the _syncPaymentStatus no-op fix.
 *
 * Before the fix, transitioning a dispute from open → under_review threw
 * INVALID_TRANSITION because both dispute statuses map to the same
 * DISPUTED payment status, and _syncPaymentStatus treated
 * (previousStatus === targetPaymentStatus) as an error instead of an
 * idempotent no-op.
 *
 * These tests call the controller functions in isolation (no Express app
 * required) by mocking Mongoose models directly.
 */

// ── Module-level setup ────────────────────────────────────────────────────────

process.env.MONGO_URI             = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPaymentFindOne  = jest.fn();
const mockDisputeFindOne  = jest.fn();
const mockDisputeUpdate   = jest.fn();
const mockStudentUpdate   = jest.fn();
const mockLogAudit        = jest.fn().mockResolvedValue(undefined);
const mockSseEmit         = jest.fn();
const mockFireWebhook     = jest.fn().mockResolvedValue({ success: true });
const mockSchoolFindOne   = jest.fn();

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne:          mockPaymentFindOne,
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  aggregate:        jest.fn().mockResolvedValue([]),
  countDocuments:   jest.fn().mockResolvedValue(0),
  create:           jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/disputeModel', () => ({
  findOne:          mockDisputeFindOne,
  findOneAndUpdate: mockDisputeUpdate,
  create:           jest.fn(),
  find:             jest.fn(),
  countDocuments:   jest.fn(),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOneAndUpdate: mockStudentUpdate,
  findOne:          jest.fn().mockResolvedValue(null),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  create:           jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: mockSchoolFindOne,
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:     mockLogAudit,
  getAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getAuditHealth: jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
}));

jest.mock('../backend/src/services/sseService', () => ({
  emit:         mockSseEmit,
  addClient:    jest.fn().mockReturnValue(true),
  removeClient: jest.fn(),
  getStats:     jest.fn().mockReturnValue({ schools: 0, connections: 0 }),
  close:        jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/webhookService', () => ({
  fireWebhook:           mockFireWebhook,
  notifyDisputeCreated:  jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeResolved: jest.fn().mockResolvedValue({ success: true }),
  generateSignature:     jest.fn().mockReturnValue('sig'),
  verifySignature:       jest.fn().mockReturnValue(true),
}));

jest.mock('../backend/src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const { resolveDispute } = require('../backend/src/controllers/dispute.controller');

const SCHOOL_ID  = 'SCH001';
const TX_HASH    = 'a'.repeat(64);
const DISPUTE_ID = '607f1f77bcf86cd799439022';
const STUDENT_ID = 'STU001';

const BASE_DISPUTE = {
  _id:        DISPUTE_ID,
  schoolId:   SCHOOL_ID,
  txHash:     TX_HASH,
  studentId:  STUDENT_ID,
  raisedBy:   'Alice Parent',
  reason:     'Wrong amount',
  createdAt:  new Date().toISOString(),
  updatedAt:  new Date().toISOString(),
};

/** Build a mock payment document with a .save() spy. */
function mockPaymentDoc(initialStatus) {
  const doc = {
    _id:      'pay-001',
    schoolId: SCHOOL_ID,
    txHash:   TX_HASH,
    status:   initialStatus,
    $locals:  {},
  };
  doc.save = jest.fn().mockImplementation(async () => doc);
  return doc;
}

/** Build minimal req / res / next objects for controller calls. */
function buildReqRes(body, params = {}) {
  const req = {
    schoolId: SCHOOL_ID,
    params:   { id: DISPUTE_ID, ...params },
    body,
    user:     { email: 'admin@school.test', id: 'admin-1', sub: 'admin-1' },
    auditContext: {
      performedBy: 'admin@school.test',
      ipAddress:   '127.0.0.1',
      userAgent:   'jest',
    },
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dispute.controller — open → under_review: _syncPaymentStatus must be a no-op', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: school has no webhook URL so _notifyDisputeChange exits early
    mockSchoolFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        schoolId:   SCHOOL_ID,
        webhookUrl: null,
      }),
    });
    mockStudentUpdate.mockResolvedValue({});
  });

  test('open → under_review returns success (no INVALID_TRANSITION thrown)', async () => {
    const currentDispute  = { ...BASE_DISPUTE, status: 'open' };
    const updatedDispute  = { ...BASE_DISPUTE, status: 'under_review', resolvedBy: 'admin@school.test', resolutionNote: 'Investigating' };

    mockDisputeFindOne.mockResolvedValueOnce(currentDispute);
    mockDisputeUpdate.mockResolvedValueOnce(updatedDispute);

    // Payment is already DISPUTED — the condition that previously threw
    const payment = mockPaymentDoc('DISPUTED');
    mockPaymentFindOne.mockResolvedValueOnce(payment);

    const { req, res, next } = buildReqRes({ resolutionNote: 'Investigating', status: 'under_review' });
    await resolveDispute(req, res, next);

    // Controller must not have forwarded an error
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'under_review' }));
  });

  test('open → under_review: .save() is NOT called when payment is already DISPUTED', async () => {
    const currentDispute = { ...BASE_DISPUTE, status: 'open' };
    const updatedDispute = { ...BASE_DISPUTE, status: 'under_review', resolvedBy: 'admin@school.test', resolutionNote: 'Investigating' };

    mockDisputeFindOne.mockResolvedValueOnce(currentDispute);
    mockDisputeUpdate.mockResolvedValueOnce(updatedDispute);

    const payment = mockPaymentDoc('DISPUTED');
    mockPaymentFindOne.mockResolvedValueOnce(payment);

    const { req, res, next } = buildReqRes({ resolutionNote: 'Investigating', status: 'under_review' });
    await resolveDispute(req, res, next);

    // _syncPaymentStatus must skip the save — DISPUTED → DISPUTED is a no-op
    expect(payment.save).not.toHaveBeenCalled();
  });

  test('under_review → resolved: .save() IS called and payment becomes REFUNDED', async () => {
    const currentDispute = { ...BASE_DISPUTE, status: 'under_review' };
    const updatedDispute = { ...BASE_DISPUTE, status: 'resolved', resolvedBy: 'admin@school.test', resolutionNote: 'Verified', resolvedAt: new Date().toISOString() };

    mockDisputeFindOne.mockResolvedValueOnce(currentDispute);
    mockDisputeUpdate.mockResolvedValueOnce(updatedDispute);

    const payment = mockPaymentDoc('DISPUTED');
    mockPaymentFindOne.mockResolvedValueOnce(payment);

    const { req, res, next } = buildReqRes({ resolutionNote: 'Verified', status: 'resolved' });
    await resolveDispute(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payment.status).toBe('REFUNDED');
    expect(payment.$locals.adminOverride).toBe(true);
    expect(payment.save).toHaveBeenCalled();
  });

  test('open → rejected: .save() IS called and payment becomes SUCCESS', async () => {
    const currentDispute = { ...BASE_DISPUTE, status: 'open' };
    const updatedDispute = { ...BASE_DISPUTE, status: 'rejected', resolvedBy: 'admin@school.test', resolutionNote: 'Denied', resolvedAt: new Date().toISOString() };

    mockDisputeFindOne.mockResolvedValueOnce(currentDispute);
    mockDisputeUpdate.mockResolvedValueOnce(updatedDispute);

    const payment = mockPaymentDoc('DISPUTED');
    mockPaymentFindOne.mockResolvedValueOnce(payment);

    const { req, res, next } = buildReqRes({ resolutionNote: 'Denied', status: 'rejected' });
    await resolveDispute(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payment.status).toBe('SUCCESS');
    expect(payment.$locals.adminOverride).toBe(true);
    expect(payment.save).toHaveBeenCalled();
  });

  test('resolved → open (re-open): .save() IS called and payment becomes DISPUTED', async () => {
    const currentDispute = { ...BASE_DISPUTE, status: 'resolved' };
    const updatedDispute = { ...BASE_DISPUTE, status: 'open', resolvedBy: 'admin@school.test', resolutionNote: 'New evidence' };

    mockDisputeFindOne.mockResolvedValueOnce(currentDispute);
    mockDisputeUpdate.mockResolvedValueOnce(updatedDispute);

    const payment = mockPaymentDoc('REFUNDED');
    mockPaymentFindOne.mockResolvedValueOnce(payment);

    const { req, res, next } = buildReqRes({ resolutionNote: 'New evidence', status: 'open' });
    await resolveDispute(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payment.status).toBe('DISPUTED');
    expect(payment.$locals.adminOverride).toBe(true);
    expect(payment.save).toHaveBeenCalled();
  });

  test('under_review → open (re-open from review): also a no-op if payment already DISPUTED', async () => {
    // under_review → open maps to DISPUTED, same as current DISPUTED — no-op
    const currentDispute = { ...BASE_DISPUTE, status: 'under_review' };
    const updatedDispute = { ...BASE_DISPUTE, status: 'open', resolvedBy: 'admin@school.test', resolutionNote: 'Reconsidering' };

    mockDisputeFindOne.mockResolvedValueOnce(currentDispute);
    mockDisputeUpdate.mockResolvedValueOnce(updatedDispute);

    const payment = mockPaymentDoc('DISPUTED');
    mockPaymentFindOne.mockResolvedValueOnce(payment);

    const { req, res, next } = buildReqRes({ resolutionNote: 'Reconsidering', status: 'open' });
    await resolveDispute(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payment.save).not.toHaveBeenCalled();
  });
});
