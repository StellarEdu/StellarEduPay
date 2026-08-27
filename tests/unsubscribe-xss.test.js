'use strict';

/**
 * Regression test for stored XSS in GET /api/reminders/unsubscribe.
 *
 * student.name is fully attacker-controlled (set via POST /api/students,
 * PUT /api/students/:id, or CSV bulk import).  The unsubscribe page is a
 * public, unauthenticated endpoint served as text/html.  This test asserts
 * that HTML special characters in student.name (and studentId) are rendered
 * as literal text, not as executable markup.
 */

// Must be set before app is loaded
process.env.MONGO_URI            = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

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
      this.plugin = jest.fn();
      this.virtual = jest.fn().mockReturnValue({ get: jest.fn() });
    }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create:           jest.fn().mockResolvedValue({}),
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne:          jest.fn().mockResolvedValue(null),
  // findOneAndUpdate returns an object that supports .select() chaining,
  // matching how reminderController.js calls it:
  //   Student.findOneAndUpdate(...).select(...)
  findOneAndUpdate: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find:             jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne:          jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  create:           jest.fn().mockResolvedValue({}),
  aggregate:        jest.fn().mockResolvedValue([]),
  countDocuments:   jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/disputeModel', () => ({
  create:           jest.fn(),
  find:             jest.fn(),
  findOne:          jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments:   jest.fn(),
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
  findByIdAndDelete: jest.fn().mockResolvedValue({}),
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

jest.mock('../backend/src/cache', () => ({
  get:      jest.fn().mockReturnValue(undefined),
  set:      jest.fn(),
  del:      jest.fn(),
  flushAll: jest.fn(),
  KEYS: {
    school:         (id) => `school:${id}`,
    acceptedAssets: () => 'accepted_assets',
    feesAll:        () => 'fees:all',
    feeByClass:     (c) => `fees:${c}`,
    studentsAll:    () => 'students:all',
    student:        (id) => `student:${id}`,
  },
  TTL: { SCHOOL: 300, FEES: 300, STUDENTS: 60, STUDENT: 60, ACCEPTED_ASSETS: 3600 },
}));

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
jest.mock('../backend/src/services/consistencyScheduler', () => ({ startConsistencyScheduler: jest.fn() }));
jest.mock('../backend/src/services/concurrentPaymentProcessor', () => ({
  concurrentPaymentProcessor: {
    getStats: jest.fn().mockReturnValue({ queueDepth: 0, maxQueueDepth: 1000 }),
  },
}), { virtual: true });
jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(),
  stopReminderScheduler:  jest.fn(),
  processReminders:       jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
  getReminderStatus:      jest.fn().mockReturnValue({ scheduled: false }),
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
  getSupportedCurrencies:      jest.fn().mockResolvedValue(new Set(['usd', 'eur'])),
  _getRates:                   jest.fn().mockResolvedValue(null),
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
  logAudit:     jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getAuditHealth: jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const request = require('supertest');
const { generateUnsubscribeToken } = require('../backend/src/utils/unsubscribeToken');
const app = require('../backend/src/app');

const JWT_SECRET = 'test-secret-32-chars-xxxxxxxxxxx';
const STUDENT_ID = 'STU001';
const SCHOOL_ID  = 'SCH001';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/reminders/unsubscribe — XSS regression (stored XSS via student.name)', () => {
  let Student;

  beforeEach(() => {
    jest.clearAllMocks();
    Student = require('../backend/src/models/studentModel');

    // resolveSchool middleware needs a working School.findOne
    const School = require('../backend/src/models/schoolModel');
    School.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        schoolId:       SCHOOL_ID,
        name:           'Test School',
        slug:           'test-school',
        stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        localCurrency:  'USD',
        isActive:       true,
        webhookUrl:     null,
      }),
    });
  });

  function makeToken() {
    return generateUnsubscribeToken(STUDENT_ID, SCHOOL_ID, JWT_SECRET);
  }

  /** Helper: mock Student.findOneAndUpdate to return the given student through .select() */
  function mockStudentResult(studentDoc) {
    Student.findOneAndUpdate.mockReturnValueOnce({
      select: jest.fn().mockResolvedValueOnce(studentDoc),
    });
  }

  test('student name containing <script> is HTML-escaped in the response body', async () => {
    const xssName = '<script>alert("xss")</script>';
    mockStudentResult({ studentId: STUDENT_ID, name: xssName, reminderOptOut: true });

    const token = makeToken();
    const res = await request(app)
      .get(`/api/reminders/unsubscribe?token=${token}`)
      .set('X-School-ID', SCHOOL_ID);

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);

    // The raw <script> tag must NOT appear verbatim in the response
    expect(res.text).not.toContain('<script>');
    expect(res.text).not.toContain('</script>');

    // The escaped version must appear instead
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain('&lt;/script&gt;');
  });

  test('student name containing HTML attribute injection is escaped', async () => {
    const xssName = '" onmouseover="alert(1)';
    mockStudentResult({ studentId: STUDENT_ID, name: xssName, reminderOptOut: true });

    const token = makeToken();
    const res = await request(app)
      .get(`/api/reminders/unsubscribe?token=${token}`)
      .set('X-School-ID', SCHOOL_ID);

    expect(res.status).toBe(200);
    // Raw double-quote from the payload must be encoded
    expect(res.text).not.toContain('" onmouseover=');
    expect(res.text).toContain('&quot;');
  });

  test('student name with & and > characters is escaped', async () => {
    const xssName = 'Alice & <Bob>';
    mockStudentResult({ studentId: STUDENT_ID, name: xssName, reminderOptOut: true });

    const token = makeToken();
    const res = await request(app)
      .get(`/api/reminders/unsubscribe?token=${token}`)
      .set('X-School-ID', SCHOOL_ID);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Bob>');
    expect(res.text).toContain('&amp;');
    expect(res.text).toContain('&lt;Bob&gt;');
  });

  test('benign student name is displayed literally (no double-escaping)', async () => {
    const safeName = 'Alice Johnson';
    mockStudentResult({ studentId: STUDENT_ID, name: safeName, reminderOptOut: true });

    const token = makeToken();
    const res = await request(app)
      .get(`/api/reminders/unsubscribe?token=${token}`)
      .set('X-School-ID', SCHOOL_ID);

    expect(res.status).toBe(200);
    // The plain name should appear verbatim (no spurious escaping)
    expect(res.text).toContain('Alice Johnson');
  });

  test('studentId containing special characters is also escaped', async () => {
    const xssId = '<img src=x onerror=alert(1)>';
    mockStudentResult({ studentId: xssId, name: 'Safe Name', reminderOptOut: true });

    const token = makeToken();
    const res = await request(app)
      .get(`/api/reminders/unsubscribe?token=${token}`)
      .set('X-School-ID', SCHOOL_ID);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img');
  });

  test('missing token returns 400', async () => {
    const res = await request(app)
      .get('/api/reminders/unsubscribe')
      .set('X-School-ID', SCHOOL_ID);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  test('invalid/tampered token returns 400', async () => {
    const res = await request(app)
      .get('/api/reminders/unsubscribe?token=tampered.token.value')
      .set('X-School-ID', SCHOOL_ID);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'INVALID_TOKEN');
  });
});
