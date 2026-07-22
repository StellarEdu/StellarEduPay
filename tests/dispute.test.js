'use strict';

// Must set required env vars before app is loaded
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  connection: {
    on:    jest.fn(),
    once:  jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    readyState: 1,
  },
  Schema: class {
    constructor() { this.index = jest.fn(); this.pre = jest.fn(); this.post = jest.fn(); this.plugin = jest.fn(); this.virtual = jest.fn().mockReturnValue({ get: jest.fn() }); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/disputeModel', () => ({
  create:           jest.fn(),
  find:             jest.fn(),
  findOne:          jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments:   jest.fn(),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne:          jest.fn(),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  create:           jest.fn().mockResolvedValue({}),
  aggregate:        jest.fn().mockResolvedValue([]),
  countDocuments:   jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create:           jest.fn().mockResolvedValue({}),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
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

jest.mock('../backend/src/models/systemConfigModel', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  findOne:          jest.fn().mockResolvedValue(null),
}));

// Mock the in-process cache so school lookups always hit the DB mock
// and tests are isolated from each other's cache state.
jest.mock('../backend/src/cache', () => ({
  get:      jest.fn().mockReturnValue(undefined),
  set:      jest.fn(),
  del:      jest.fn(),
  flushAll: jest.fn(),
  KEYS:     {
    school:         (id) => `school:${id}`,
    acceptedAssets: () => 'accepted_assets',
    feesAll:        () => 'fees:all',
    feeByClass:     (c) => `fees:${c}`,
    studentsAll:    () => 'students:all',
    student:        (id) => `student:${id}`,
  },
  TTL: { SCHOOL: 300, FEES: 300, STUDENTS: 60, STUDENT: 60, ACCEPTED_ASSETS: 3600 },
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

jest.mock('../backend/src/models/systemConfigModel', () => ({
  get:             jest.fn().mockResolvedValue(null),
  set:             jest.fn().mockResolvedValue(null),
  findOne:         jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId:       'SCH001',
      name:           'Test School',
      slug:           'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency:  'USD',
      webhookUrl:     null,
      webhookSecret:  null,
      isActive:       true,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));

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

jest.mock('../backend/src/services/retryServiceSelector', () => ({
  start:     jest.fn(),
  stop:      jest.fn(),
  useBullMQ: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/stuckPaymentReconciliation', () => ({
  reconcileStuckPayments: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/transactionQueueService', () => ({
  startWorker: jest.fn(),
  stopWorker:  jest.fn(),
}));

jest.mock('../backend/src/queue/transactionQueue', () => ({
  recoverPendingJobs: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/leaderElection', () => ({
  register: jest.fn(),
  start:    jest.fn().mockResolvedValue(undefined),
  stop:     jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/outboxDispatcher', () => ({
  startOutboxDispatcher: jest.fn(),
}));

jest.mock('../backend/src/services/sessionCleanupService', () => ({
  startSessionCleanupScheduler: jest.fn(),
  stopSessionCleanupScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/auditLogCleanupService', () => ({
  startAuditLogCleanupScheduler: jest.fn(),
  stopAuditLogCleanupScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/webhookRetryScheduler', () => ({
  startWebhookRetryScheduler: jest.fn(),
  stopWebhookRetryScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/reconciliationReportScheduler', () => ({
  startReconciliationReportScheduler: jest.fn(),
  stopReconciliationReportScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/reconciliationService', () => ({
  startReconciliationScheduler: jest.fn(),
  stopReconciliationScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/metricsRollupService', () => ({
  startMetricsRollupScheduler: jest.fn(),
  stopMetricsRollupScheduler:  jest.fn(),
}));

jest.mock('../backend/src/services/paymentSavedSubscribers', () => ({
  registerPaymentSavedSubscribers: jest.fn(),
}));

jest.mock('../backend/src/services/transactionPollingService', () => ({
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
  isSupportedCurrency:         jest.fn().mockResolvedValue({ valid: true }),
  getSupportedCurrencies:      jest.fn().mockResolvedValue(new Set(['usd', 'eur', 'ngn'])),
  _getRates:                   jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/services/sseService', () => ({
  emit:        jest.fn(),
  addClient:   jest.fn().mockReturnValue(true),
  removeClient: jest.fn(),
  getStats:    jest.fn().mockReturnValue({ schools: 0, connections: 0 }),
  close:       jest.fn(),
}));

jest.mock('../backend/src/services/webhookService', () => ({
  fireWebhook: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:               jest.fn().mockResolvedValue(undefined),
  getAuditLogs:           jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getRecentAuditLogs:     jest.fn().mockResolvedValue([]),
  getAuditHealth:         jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
  verifyAuditChain:       jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  archiveAuditLogs:       jest.fn().mockResolvedValue(0),
  _resetAuditFailureCount: jest.fn(),
  _computeEntryHash:      jest.fn().mockReturnValue('deadbeef'),
}));

jest.mock('../backend/src/services/sseService', () => ({
  addClient:    jest.fn().mockReturnValue(true),
  removeClient: jest.fn(),
  emit:         jest.fn(),
  getStats:     jest.fn().mockReturnValue({ schools: 0, connections: 0 }),
  close:        jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/webhookService', () => ({
  fireWebhook:              jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentConfirmed:   jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentPending:     jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentFailed:      jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentRefunded:    jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentSuspicious:  jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeCreated:     jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeResolved:    jest.fn().mockResolvedValue({ success: true }),
  sendPaymentWebhook:       jest.fn().mockResolvedValue({ success: true }),
  generateSignature:        jest.fn().mockReturnValue('sig'),
  verifySignature:          jest.fn().mockReturnValue(true),
  queueWebhookRetry:        jest.fn().mockResolvedValue(undefined),
  processPendingRetries:    jest.fn().mockResolvedValue({ processed: 0 }),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:         jest.fn().mockResolvedValue(undefined),
  getAuditLogs:     jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getAuditHealth:   jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
}));

const app = require('../backend/src/app');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function api(method, path) {
  return request(app)[method](path).set('X-School-ID', 'SCH001');
}

const ADMIN_TOKEN = require('jsonwebtoken').sign(
  { role: 'admin', email: 'admin@school.test', sub: 'admin-1' },
  'test-secret',
  { expiresIn: '1h' },
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PAYMENT = {
  _id: '507f1f77bcf86cd799439011',
  schoolId: 'SCH001',
  txHash: 'a'.repeat(64),
  studentId: 'STU001',
  amount: 200,
  status: 'SUCCESS',
};

const MOCK_DISPUTE = {
  _id: '607f1f77bcf86cd799439022',
  schoolId: 'SCH001',
  txHash: 'a'.repeat(64),
  studentId: 'STU001',
  raisedBy: 'Alice Parent',
  reason: 'Amount was already paid in cash',
  status: 'open',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ─── POST /api/disputes ───────────────────────────────────────────────────────

describe('POST /api/disputes — flag a dispute', () => {
  let Dispute, Payment;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    Dispute = require('../backend/src/models/disputeModel');
    Payment = require('../backend/src/models/paymentModel');
    jest.clearAllMocks();
  });

  test('201 — creates dispute when payment exists and no active dispute', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);

    const res = await api('post', '/api/disputes').send({
      txHash: MOCK_PAYMENT.txHash, studentId: 'STU001',
      raisedBy: 'Alice Parent', reason: 'Already paid in cash',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ txHash: MOCK_PAYMENT.txHash, status: 'open' });
  });

  test('400 — missing required fields', async () => {
    const res = await api('post', '/api/disputes').send({ txHash: MOCK_PAYMENT.txHash });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('404 — payment not found', async () => {
    Payment.findOne.mockResolvedValueOnce(null);

    const res = await api('post', '/api/disputes').send({
      txHash: MOCK_PAYMENT.txHash, studentId: 'STU001',
      raisedBy: 'Alice', reason: 'Wrong amount',
    });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  test('409 — duplicate active dispute', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(MOCK_DISPUTE);

    const res = await api('post', '/api/disputes').send({
      txHash: MOCK_PAYMENT.txHash, studentId: 'STU001',
      raisedBy: 'Alice', reason: 'Duplicate',
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('code', 'DISPUTE_ALREADY_EXISTS');
    expect(res.body).toHaveProperty('disputeId');
  });
});

// ─── GET /api/disputes ────────────────────────────────────────────────────────

describe('GET /api/disputes — list disputes', () => {
  let Dispute;

  beforeEach(() => {
    Dispute = require('../backend/src/models/disputeModel');
    jest.clearAllMocks();
  });

  test('200 — returns paginated disputes', async () => {
    Dispute.find.mockReturnValueOnce({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValueOnce([MOCK_DISPUTE]),
    });
    Dispute.countDocuments.mockResolvedValueOnce(1);

    const res = await api('get', '/api/disputes');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.disputes)).toBe(true);
    expect(res.body.disputes[0]).toMatchObject({ status: 'open' });
    expect(res.body.pagination).toMatchObject({ page: 1, total: 1 });
  });

  test('200 — returns empty list', async () => {
    Dispute.find.mockReturnValueOnce({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValueOnce([]),
    });
    Dispute.countDocuments.mockResolvedValueOnce(0);

    const res = await api('get', '/api/disputes');
    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(0);
  });
});

// ─── GET /api/disputes/:id ────────────────────────────────────────────────────

describe('GET /api/disputes/:id — get single dispute', () => {
  let Dispute;

  beforeEach(() => {
    Dispute = require('../backend/src/models/disputeModel');
    jest.clearAllMocks();
  });

  test('200 — returns the dispute', async () => {
    Dispute.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce(MOCK_DISPUTE) });
    const res = await api('get', `/api/disputes/${MOCK_DISPUTE._id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ _id: MOCK_DISPUTE._id, status: 'open' });
  });

  test('404 — dispute not found', async () => {
    Dispute.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce(null) });
    const res = await api('get', '/api/disputes/000000000000000000000000');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });
});

// ─── PATCH /api/disputes/:id/resolve ─────────────────────────────────────────

describe('PATCH /api/disputes/:id/resolve — state machine, auth, audit, SSE, payment sync', () => {
  let Dispute, Payment, auditService, sseService;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    Dispute      = require('../backend/src/models/disputeModel');
    Payment      = require('../backend/src/models/paymentModel');
    auditService = require('../backend/src/services/auditService');
    sseService   = require('../backend/src/services/sseService');
    jest.clearAllMocks();
  });

  // ── Authentication (#895) ──────────────────────────────────────────────────

  test('401 — no token', async () => {
    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .send({ resolutionNote: 'Done' });
    expect(res.status).toBe(401);
  });

  test('403 — non-admin token rejected', async () => {
    const userToken = require('jsonwebtoken').sign({ role: 'user' }, 'test-secret', { expiresIn: '1h' });
    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ resolutionNote: 'Trying' });
    expect(res.status).toBe(403);
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  test('400 — missing resolutionNote', async () => {
    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('404 — dispute not found', async () => {
    Dispute.findOne.mockResolvedValueOnce(null);
    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Done' });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  // ── Valid transitions (#895) ───────────────────────────────────────────────

  test('200 — open → resolved', async () => {
    const resolved = { ...MOCK_DISPUTE, status: 'resolved', resolvedBy: 'admin@school.test', resolutionNote: 'Verified', resolvedAt: new Date().toISOString() };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'open' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolved);

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Verified', status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', resolvedBy: 'admin@school.test' });
  });

  test('200 — open → under_review', async () => {
    const updated = { ...MOCK_DISPUTE, status: 'under_review', resolvedBy: 'admin@school.test', resolutionNote: 'Investigating' };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'open' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(updated);

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Investigating', status: 'under_review' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('under_review');
  });

  test('200 — under_review → rejected', async () => {
    const rejected = { ...MOCK_DISPUTE, status: 'rejected', resolvedBy: 'admin@school.test', resolutionNote: 'Denied' };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'under_review' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(rejected);

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Denied', status: 'rejected' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('200 — resolved → open (re-open path)', async () => {
    const reopened = { ...MOCK_DISPUTE, status: 'open', resolvedBy: 'admin@school.test', resolutionNote: 'New evidence' };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'resolved' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(reopened);

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'New evidence', status: 'open' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
  });

  test('200 — rejected → open (re-open path)', async () => {
    const reopened = { ...MOCK_DISPUTE, status: 'open', resolvedBy: 'admin@school.test', resolutionNote: 'Reconsidering' };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'rejected' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(reopened);

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Reconsidering', status: 'open' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
  });

  // ── Invalid transitions (#895) ─────────────────────────────────────────────

  test('422 — rejected → resolved is invalid', async () => {
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'rejected' });

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Re-resolving', status: 'resolved' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('code', 'INVALID_DISPUTE_TRANSITION');
    expect(res.body).toHaveProperty('currentStatus', 'rejected');
    expect(res.body.allowedTransitions).toContain('open');
  });

  test('422 — resolved → under_review is invalid', async () => {
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'resolved' });

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Back to review', status: 'under_review' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('code', 'INVALID_DISPUTE_TRANSITION');
  });

  test('422 — open → open (self-loop) is invalid', async () => {
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'open' });

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'No-op', status: 'open' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('code', 'INVALID_DISPUTE_TRANSITION');
  });

  // ── Audit trail (#894) ─────────────────────────────────────────────────────

  test('audit entry written with actor and transition details', async () => {
    const resolved = { ...MOCK_DISPUTE, status: 'resolved', resolvedBy: 'admin@school.test', resolutionNote: 'Done', txHash: MOCK_DISPUTE.txHash };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'open' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolved);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Done', status: 'resolved' });

    expect(auditService.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:      'dispute_resolved',
        performedBy: 'admin@school.test',
        targetType:  'dispute',
        details:     expect.objectContaining({ fromStatus: 'open', toStatus: 'resolved' }),
      }),
    );
  });

  // ── SSE (#894) ─────────────────────────────────────────────────────────────

  test('SSE event emitted on resolution', async () => {
    const resolved = { ...MOCK_DISPUTE, status: 'resolved', resolvedBy: 'admin@school.test', resolutionNote: 'Done', txHash: MOCK_DISPUTE.txHash };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'open' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolved);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Done', status: 'resolved' });

    expect(sseService.emit).toHaveBeenCalledWith(
      'SCH001', 'dispute.resolved',
      expect.objectContaining({ status: 'resolved' }),
    );
  });

  test('SSE event is dispute.reopened when transitioning to open', async () => {
    const reopened = { ...MOCK_DISPUTE, status: 'open', resolvedBy: 'admin@school.test', resolutionNote: 'New evidence', txHash: MOCK_DISPUTE.txHash };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'resolved' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(reopened);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'New evidence', status: 'open' });

    expect(sseService.emit).toHaveBeenCalledWith(
      'SCH001', 'dispute.reopened',
      expect.objectContaining({ status: 'open' }),
    );
  });

  // ── Payment status sync (#894) ─────────────────────────────────────────────

  // _syncPaymentStatus now loads the payment and goes through `.save()` (with
  // the admin-override flag) instead of `findOneAndUpdate`, so these mocks
  // need a document-like object that records the mutation.
  function mockLoadedPayment(initialStatus) {
    const doc = { ...MOCK_PAYMENT, status: initialStatus, $locals: {} };
    doc.save = jest.fn().mockImplementation(async () => doc);
    return doc;
  }

  test('payment synced to REFUNDED when dispute resolved', async () => {
    const resolved = { ...MOCK_DISPUTE, status: 'resolved', resolvedBy: 'admin@school.test', resolutionNote: 'Done', txHash: MOCK_DISPUTE.txHash };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'open' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolved);
    const payment = mockLoadedPayment('SUCCESS');
    Payment.findOne.mockResolvedValueOnce(payment);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Done', status: 'resolved' });

    expect(Payment.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: MOCK_DISPUTE.txHash }),
    );
    expect(payment.$locals.adminOverride).toBe(true);
    expect(payment.status).toBe('REFUNDED');
    expect(payment.save).toHaveBeenCalled();
  });

  test('payment synced to SUCCESS when dispute rejected', async () => {
    const rejected = { ...MOCK_DISPUTE, status: 'rejected', resolvedBy: 'admin@school.test', resolutionNote: 'Denied', txHash: MOCK_DISPUTE.txHash };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'under_review' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(rejected);
    const payment = mockLoadedPayment('DISPUTED');
    Payment.findOne.mockResolvedValueOnce(payment);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Denied', status: 'rejected' });

    expect(Payment.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: MOCK_DISPUTE.txHash }),
    );
    expect(payment.$locals.adminOverride).toBe(true);
    expect(payment.status).toBe('SUCCESS');
    expect(payment.save).toHaveBeenCalled();
  });

  test('payment synced to DISPUTED when dispute re-opened', async () => {
    const reopened = { ...MOCK_DISPUTE, status: 'open', resolvedBy: 'admin@school.test', resolutionNote: 'New evidence', txHash: MOCK_DISPUTE.txHash };
    Dispute.findOne.mockResolvedValueOnce({ ...MOCK_DISPUTE, status: 'resolved' });
    Dispute.findOneAndUpdate.mockResolvedValueOnce(reopened);
    const payment = mockLoadedPayment('REFUNDED');
    Payment.findOne.mockResolvedValueOnce(payment);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'New evidence', status: 'open' });

    expect(Payment.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: MOCK_DISPUTE.txHash }),
    );
    expect(payment.$locals.adminOverride).toBe(true);
    expect(payment.status).toBe('DISPUTED');
    expect(payment.save).toHaveBeenCalled();
  });
});

// ─── Dispute-hold: notification on creation ───────────────────────────────────

describe('Dispute creation — notifications and hold', () => {
  let Dispute, Payment, Student, sseService, webhookService, auditService, School;
  const ADMIN_TOKEN = require('jsonwebtoken').sign(
    { role: 'admin', sub: 'admin-1' },
    'test-secret',
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    Dispute       = require('../backend/src/models/disputeModel');
    Payment       = require('../backend/src/models/paymentModel');
    Student       = require('../backend/src/models/studentModel');
    School        = require('../backend/src/models/schoolModel');
    sseService    = require('../backend/src/services/sseService');
    webhookService = require('../backend/src/services/webhookService');
    auditService  = require('../backend/src/services/auditService');

    // Restore default school mock after clearAllMocks wipes mock return values.
    // resolveSchool middleware calls School.findOne once per request (cache is
    // mocked to always miss). Tests that need specific controller-level School
    // data set up an additional mockReturnValueOnce *after* this default.
    School.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        schoolId:       'SCH001',
        name:           'Test School',
        slug:           'test-school',
        stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        localCurrency:  'USD',
        isActive:       true,
        webhookUrl:     null,
      }),
    });
  });

  test('SSE dispute.created event is emitted when a dispute is created', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    await api('post', '/api/disputes').send({
      txHash:    MOCK_PAYMENT.txHash,
      studentId: 'STU001',
      raisedBy:  'Alice Parent',
      reason:    'Wrong amount',
    });

    expect(sseService.emit).toHaveBeenCalledWith(
      'SCH001',
      'dispute.created',
      expect.objectContaining({ txHash: MOCK_PAYMENT.txHash, studentId: 'STU001', status: 'open' })
    );
  });

  test('webhook notifyDisputeCreated is called when school has a webhookUrl', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);
    Student.findOneAndUpdate.mockResolvedValueOnce({});
    // First call: resolveSchool middleware; second call: controller webhook lookup
    School.findOne
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce({ schoolId: 'SCH001', isActive: true }) })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValueOnce({
          schoolId:      'SCH001',
          webhookUrl:    'https://example.com/webhook',
          webhookSecret: 'secret',
        }),
      });

    await api('post', '/api/disputes').send({
      txHash:    MOCK_PAYMENT.txHash,
      studentId: 'STU001',
      raisedBy:  'Alice Parent',
      reason:    'Wrong amount',
    });

    // Give the fire-and-forget promise time to resolve
    await new Promise((r) => setImmediate(r));

    expect(webhookService.notifyDisputeCreated).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ txHash: MOCK_PAYMENT.txHash }),
      'secret'
    );
  });

  test('webhook is NOT called when school has no webhookUrl', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    await api('post', '/api/disputes').send({
      txHash:    MOCK_PAYMENT.txHash,
      studentId: 'STU001',
      raisedBy:  'Alice Parent',
      reason:    'Wrong amount',
    });

    await new Promise((r) => setImmediate(r));

    expect(webhookService.notifyDisputeCreated).not.toHaveBeenCalled();
  });

  test('disputeHold is set to true on the student when a dispute is created', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    const res = await api('post', '/api/disputes').send({
      txHash:    MOCK_PAYMENT.txHash,
      studentId: 'STU001',
      raisedBy:  'Alice Parent',
      reason:    'Wrong amount',
    });

    expect(res.status).toBe(201);
    expect(Student.findOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: 'SCH001', studentId: 'STU001' },
      { $set: { disputeHold: true } }
    );
  });

  test('audit log is written on dispute creation', async () => {
    Payment.findOne.mockResolvedValueOnce(MOCK_PAYMENT);
    Dispute.findOne.mockResolvedValueOnce(null);
    Dispute.create.mockResolvedValueOnce(MOCK_DISPUTE);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    await api('post', '/api/disputes').send({
      txHash:    MOCK_PAYMENT.txHash,
      studentId: 'STU001',
      raisedBy:  'Alice Parent',
      reason:    'Wrong amount',
    });

    expect(auditService.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId:    'SCH001',
        action:      'dispute_created',
        targetType:  'dispute',
        result:      'success',
      })
    );
  });
});

// ─── Dispute-hold: reminder suppression ──────────────────────────────────────
// See tests/disputeHold.test.js for reminder-suppression and hold-lifted tests.
// Those tests use jest.resetModules() which must run in a separate file so they
// don't corrupt the module registry for other describe blocks in this file.

// ─── Dispute-hold: hold lifted on resolution ─────────────────────────────────

describe('Dispute resolution — hold lifted on terminal status', () => {
  let Dispute, Student, School, sseService, webhookService, auditService;
  const ADMIN_TOKEN = require('jsonwebtoken').sign(
    { role: 'admin', sub: 'admin-1' },
    'test-secret',
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    Dispute       = require('../backend/src/models/disputeModel');
    Student       = require('../backend/src/models/studentModel');
    School        = require('../backend/src/models/schoolModel');
    sseService    = require('../backend/src/services/sseService');
    webhookService = require('../backend/src/services/webhookService');
    auditService  = require('../backend/src/services/auditService');

    // The controller loads the current dispute (#895 state-machine check) before
    // applying the transition; default it to an open dispute so transitions validate.
    Dispute.findOne.mockResolvedValue({ ...MOCK_DISPUTE, status: 'open' });

    // Restore default school mock after clearAllMocks wipes mock return values.
    School.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        schoolId:       'SCH001',
        name:           'Test School',
        slug:           'test-school',
        stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        localCurrency:  'USD',
        isActive:       true,
        webhookUrl:     null,
      }),
    });
  });

  const resolvedDispute = {
    ...MOCK_DISPUTE,
    status:         'resolved',
    resolvedBy:     'admin-1',
    resolutionNote: 'Verified and closed',
    resolvedAt:     new Date().toISOString(),
    holdLifted:     true,
  };

  test('disputeHold is cleared on the student when dispute is resolved', async () => {
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolvedDispute);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Verified and closed' });

    expect(res.status).toBe(200);
    expect(Student.findOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: 'SCH001', studentId: MOCK_DISPUTE.studentId },
      { $set: { disputeHold: false } }
    );
  });

  test('disputeHold is cleared when status is set to rejected', async () => {
    const rejectedDispute = { ...resolvedDispute, status: 'rejected' };
    Dispute.findOneAndUpdate.mockResolvedValueOnce(rejectedDispute);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    const res = await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Claim rejected', status: 'rejected' });

    expect(res.status).toBe(200);
    expect(Student.findOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: 'SCH001', studentId: MOCK_DISPUTE.studentId },
      { $set: { disputeHold: false } }
    );
  });

  test('disputeHold is NOT cleared when status moves to under_review (non-terminal)', async () => {
    const underReview = { ...MOCK_DISPUTE, status: 'under_review', resolvedBy: 'admin-1', resolutionNote: 'Investigating' };
    Dispute.findOneAndUpdate.mockResolvedValueOnce(underReview);

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Investigating', status: 'under_review' });

    // Student.findOneAndUpdate should NOT be called to change the hold
    const holdClears = (Student.findOneAndUpdate.mock.calls || []).filter(
      (call) => call[1]?.$set?.disputeHold === false
    );
    expect(holdClears).toHaveLength(0);
  });

  test('SSE dispute.resolved event is emitted on resolution', async () => {
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolvedDispute);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Verified and closed' });

    expect(sseService.emit).toHaveBeenCalledWith(
      'SCH001',
      'dispute.resolved',
      expect.objectContaining({ status: 'resolved', holdLifted: true })
    );
  });

  test('webhook notifyDisputeResolved is called on resolution when school has webhookUrl', async () => {
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolvedDispute);
    Student.findOneAndUpdate.mockResolvedValueOnce({});
    // First call: resolveSchool middleware; second call: controller webhook lookup
    School.findOne
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValueOnce({ schoolId: 'SCH001', isActive: true }) })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValueOnce({
          schoolId:      'SCH001',
          webhookUrl:    'https://example.com/webhook',
          webhookSecret: 'secret',
        }),
      });

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Verified and closed' });

    await new Promise((r) => setImmediate(r));

    expect(webhookService.notifyDisputeResolved).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ status: 'resolved' }),
      'secret'
    );
  });

  test('audit log is written on dispute resolution', async () => {
    Dispute.findOneAndUpdate.mockResolvedValueOnce(resolvedDispute);
    Student.findOneAndUpdate.mockResolvedValueOnce({});

    await api('patch', `/api/disputes/${MOCK_DISPUTE._id}/resolve`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ resolutionNote: 'Verified and closed' });

    expect(auditService.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId:   'SCH001',
        action:     'dispute_resolved',
        targetType: 'dispute',
        result:     'success',
      })
    );
  });
});
