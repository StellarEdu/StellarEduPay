'use strict';

/**
 * All-Routes Authentication Coverage
 *
 * Walks the LIVE Express router stack (app._router) and asserts, for every
 * mounted route in the application, that an unauthenticated request receives
 * 401 or 403 — unless the method+path appears on the documented public-endpoint
 * allowlist (backend/src/config/publicEndpoints.js).
 *
 * This closes the class of bug behind the header-trust gap where dispute and
 * fee-adjustment handlers were reachable with nothing but a guessable
 * X-School-ID header: resolveSchool treats that header as tenant CONTEXT (an
 * identifier, not a credential) and only validates it against a JWT when one
 * happens to be present, so any handler mounted without an auth middleware was
 * anonymous by accident.
 *
 * A future handler cannot be published by omission: forgetting the auth
 * middleware fails this test until the route is fixed or explicitly added to
 * PUBLIC_ENDPOINTS with a written threat model.
 */

// Env must be set BEFORE requiring app. RATE_LIMIT_MAX_REQUESTS is raised so
// probing every route does not trip the global 100/min/IP limiter (the limiter
// honours these documented env vars; production defaults are unchanged).
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-key-for-route-auth-coverage';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

const request = require('supertest');

// ── Mocks (same scaffold as tests/dispute.test.js so app boots without DB/Redis)
jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  connection: {
    on: jest.fn(), once: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    readyState: 1,
  },
  Schema: class {
    constructor() { this.index = jest.fn(); this.pre = jest.fn(); this.post = jest.fn(); this.plugin = jest.fn(); this.virtual = jest.fn().mockReturnValue({ get: jest.fn() }); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  // resolveSchool hits this for EVERY probed route; always answer with an
  // active school so protected routes fail at the AUTH layer (401), not at
  // tenant resolution (404).
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId: 'SCH001', name: 'Test School', slug: 'test-school',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      localCurrency: 'USD', webhookUrl: null, webhookSecret: null, isActive: true,
    }),
  }),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/systemConfigModel', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(null),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../backend/src/models/disputeModel', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(),
  findOneAndUpdate: jest.fn(), countDocuments: jest.fn(),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
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

jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/config/retryQueueSetup', () => ({
  initializeRetryQueue: jest.fn(), setupMonitoring: jest.fn(),
}));

jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/retryServiceSelector', () => ({
  start: jest.fn(), stop: jest.fn(), useBullMQ: jest.fn().mockReturnValue(false),
}));

jest.mock('../backend/src/services/stuckPaymentReconciliation', () => ({
  reconcileStuckPayments: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/transactionQueueService', () => ({
  startWorker: jest.fn(), stopWorker: jest.fn(),
}));

jest.mock('../backend/src/queue/transactionQueue', () => ({
  recoverPendingJobs: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/leaderElection', () => ({
  register: jest.fn(), start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/outboxDispatcher', () => ({
  startOutboxDispatcher: jest.fn(),
}));

jest.mock('../backend/src/services/sessionCleanupService', () => ({
  startSessionCleanupScheduler: jest.fn(), stopSessionCleanupScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/auditLogCleanupService', () => ({
  startAuditLogCleanupScheduler: jest.fn(), stopAuditLogCleanupScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/webhookRetryScheduler', () => ({
  startWebhookRetryScheduler: jest.fn(), stopWebhookRetryScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/reconciliationReportScheduler', () => ({
  startReconciliationReportScheduler: jest.fn(), stopReconciliationReportScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/reconciliationService', () => ({
  startReconciliationScheduler: jest.fn(), stopReconciliationScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/metricsRollupService', () => ({
  startMetricsRollupScheduler: jest.fn(), stopMetricsRollupScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/paymentSavedSubscribers', () => ({
  registerPaymentSavedSubscribers: jest.fn(),
}));

jest.mock('../backend/src/services/transactionPollingService', () => ({
  startPolling: jest.fn(), stopPolling: jest.fn(),
}));

jest.mock('../backend/src/services/consistencyScheduler', () => ({
  startConsistencyScheduler: jest.fn(),
}));

jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(), stopReminderScheduler: jest.fn(),
  processReminders: jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
}));

jest.mock('../backend/src/services/reportQueueService', () => ({
  startWorker: jest.fn(), stopWorker: jest.fn(),
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

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getRecentAuditLogs: jest.fn().mockResolvedValue([]),
  getAuditHealth: jest.fn().mockReturnValue({ status: 'ok', recentFailures: 0 }),
  verifyAuditChain: jest.fn().mockResolvedValue({ ok: true, scanned: 0, broken: [] }),
  archiveAuditLogs: jest.fn().mockResolvedValue(0),
  _resetAuditFailureCount: jest.fn(),
  _computeEntryHash: jest.fn().mockReturnValue('deadbeef'),
}));

jest.mock('../backend/src/services/webhookService', () => ({
  fireWebhook: jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentConfirmed: jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentPending: jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentFailed: jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentRefunded: jest.fn().mockResolvedValue({ success: true }),
  notifyPaymentSuspicious: jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeCreated: jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeResolved: jest.fn().mockResolvedValue({ success: true }),
  sendPaymentWebhook: jest.fn().mockResolvedValue({ success: true }),
  generateSignature: jest.fn().mockReturnValue('sig'),
  verifySignature: jest.fn().mockReturnValue(true),
  queueWebhookRetry: jest.fn().mockResolvedValue(undefined),
  processPendingRetries: jest.fn().mockResolvedValue({ processed: 0 }),
}));

jest.mock('../backend/src/services/sseService', () => ({
  addClient: jest.fn().mockReturnValue(true),
  removeClient: jest.fn(),
  emit: jest.fn(),
  getStats: jest.fn().mockReturnValue({ schools: 0, connections: 0 }),
  close: jest.fn().mockResolvedValue(undefined),
}));

const app = require('../backend/src/app');
const { PUBLIC_ENDPOINTS, isPublicEndpoint } = require('../backend/src/config/publicEndpoints');

// ── Router-stack walking ───────────────────────────────────────────────────────

/**
 * Recover the mount prefix of an app.use('/x', router) layer from its regexp.
 * Express 4 compiles '/api/disputes' to /^\/api\/disputes\/?(?=\/|$)/i, whose
 * .source ends with the literal characters:  \/?(?=\/|$)
 */
function mountPrefix(regexp) {
  if (!regexp || regexp.fast_slash) return '';
  let src = regexp.source;
  const tailIdx = src.indexOf('\\/?(');
  if (tailIdx === 0) return '';
  if (tailIdx > 0) {
    src = src.slice(1, tailIdx);            // strip leading '^' and the tail
  } else {
    src = src.replace(/^\^/, '').replace(/\$$/, '');
  }
  return src.replace(/\\\//g, '/');
}

function normalizeJoin(prefix, routePath) {
  if (routePath === '*') return prefix + '/<wildcard>';
  const joined = prefix + routePath;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

function collectRoutes(stack, prefix = '', out = []) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.entries(layer.route.methods || {})
        .filter(([, enabled]) => enabled)
        .map(([m]) => m.toUpperCase());
      for (const method of methods) {
        out.push({
          method,
          path: normalizeJoin(prefix, layer.route.path),
          wildcard: layer.route.path === '*',
        });
      }
    } else if (!layer.route && layer.handle && Array.isArray(layer.handle.stack)) {
      collectRoutes(layer.handle.stack, prefix + mountPrefix(layer.regexp), out);
    }
  }
  return out;
}

const mountedRoutes = collectRoutes(app._router.stack);

// ── Concrete-path construction ────────────────────────────────────────────────

const PARAM_VALUES = {
  id: '507f1f77bcf86cd799439011',
  studentId: 'STU001',
  txHash: 'a'.repeat(64),
  receiptId: '507f1f77bcf86cd799439011',
  paymentId: '507f1f77bcf86cd799439011',
  refundId: '507f1f77bcf86cd799439011',
  jobId: 'job-1',
  sessionId: 'session-1',
  className: 'Grade1',
  provider: 'sendgrid',
  state: 'waiting',
  installmentIndex: '0',
  schoolId: 'SCH001',
  slug: 'test-school',
  key: 'someKey',
  email: 'user%40example.com',
};

function concretePath(pattern) {
  return pattern.split('/').map((seg) =>
    seg.startsWith(':') ? (PARAM_VALUES[seg.slice(1)] || 'x-test') : seg
  ).join('/');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('route auth coverage — no mounted route is reachable without authentication unless allowlisted', () => {
  test('router walk found the mounted API surface', () => {
    expect(mountedRoutes.length).toBeGreaterThan(50);
  });

  const guarded = mountedRoutes.filter(
    (route) => !isPublicEndpoint(route.method, route.path)
  );

  test.each(
    guarded.map((r) => [`${r.method} ${r.path}`, r])
  )('%s rejects unauthenticated requests with 401/403', async (_label, route) => {
    const res = await request(app)[route.method.toLowerCase()](concretePath(route.path))
      .set('X-School-ID', 'SCH001')
      .send({});

    expect([401, 403]).toContain(res.status);
  });

  test('a meaningful share of routes was actually probed (walker sanity)', () => {
    expect(guarded.length).toBeGreaterThan(40);
  });
});

describe('public-endpoint allowlist hygiene — entries must point at real routes', () => {
  function patternMatches(entry, route) {
    // '<wildcard>' layers only match "prefix/*" entries.
    const entrySegments = entry.path.replace(/\/\*$/, '').split('/').filter(Boolean);
    const routeSegments = route.path.split('/').filter((s) => s && s !== '<wildcard>');
    return entrySegments.length === routeSegments.length &&
      entrySegments.every((seg, i) => seg.startsWith(':') || seg === routeSegments[i]);
  }

  test('no stale allowlist entries', () => {
    const problems = [];

    for (const entry of PUBLIC_ENDPOINTS) {
      if (entry.path === '/api/docs' || entry.path === '/api/docs/*') {
        // Swagger UI is dev-only and may legitimately be absent.
        continue;
      }
      const exists = mountedRoutes.some((route) =>
        (entry.method === '*' || route.method === entry.method) &&
        patternMatches(entry, route)
      );
      if (!exists) problems.push(`${entry.method} ${entry.path}`);
    }

    expect(problems).toEqual([]);
  });
});
