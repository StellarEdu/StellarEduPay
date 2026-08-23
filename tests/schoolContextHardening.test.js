'use strict';

/**
 * resolveSchool hardening — identifiers are not credentials
 *
 * Covers the tenant-resolution behaviours required by the header-trust gap fix:
 *   1. Unknown and inactive schools produce IDENTICAL responses (no
 *      enumeration oracle distinguishing real school IDs from fake ones).
 *   2. A request presenting an expired/malformed JWT gets 401 from
 *      resolveSchool itself — "presented a broken credential" is not treated
 *      as "presented no credential".
 *   3. Tenant binding still rejects cross-school tokens with 403.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret-key-for-school-context';

const request = require('supertest');

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

// In-memory cache mock so per-test DB stubs are always consulted.
jest.mock('../backend/src/cache', () => ({
  get: jest.fn(() => undefined),
  set: jest.fn(),
  del: jest.fn(),
  delByPrefix: jest.fn(),
  flushAll: jest.fn(),
  KEYS: { school: (id) => `school:${id}` },
  TTL: { SCHOOL: 300 },
}));

const ACTIVE_SCHOOL = {
  schoolId: 'SCH-ACTIVE',
  name: 'Active School',
  slug: 'active-school',
  stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  localCurrency: 'USD',
  isActive: true,
};

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn(),
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/systemConfigModel', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(null),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

// disputeRoutes mounts resolveSchool first — GET /api/disputes/anything is a
// convenient probe for middleware behaviour. The auth middleware behind it is
// mocked to passthrough so we observe resolveSchool's own decisions.
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
}));

jest.mock('../backend/src/config/retryQueueSetup', () => ({ initializeRetryQueue: jest.fn(), setupMonitoring: jest.fn() }));
jest.mock('../backend/src/services/retryService', () => ({
  queueForRetry: jest.fn().mockResolvedValue(undefined),
  startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));
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
jest.mock('../backend/src/services/reminderService', () => ({
  startReminderScheduler: jest.fn(), stopReminderScheduler: jest.fn(),
  processReminders: jest.fn().mockResolvedValue({ schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 }),
}));
jest.mock('../backend/src/services/reportQueueService', () => ({ startWorker: jest.fn(), stopWorker: jest.fn() }));
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
  verifyAuditChain: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../backend/src/services/webhookService', () => ({
  fireWebhook: jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeCreated: jest.fn().mockResolvedValue({ success: true }),
  notifyDisputeResolved: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../backend/src/services/sseService', () => ({
  addClient: jest.fn(), removeClient: jest.fn(), emit: jest.fn(),
  getStats: jest.fn().mockReturnValue({ schools: 0, connections: 0 }), close: jest.fn(),
}));

const app = require('../backend/src/app');
const jwt = require('jsonwebtoken');
const School = require('../backend/src/models/schoolModel');

// Point the school lookup at an arbitrary doc (or null for "unknown").
function setNextSchool(doc) {
  School.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) });
}

beforeEach(() => {
  jest.clearAllMocks();
  setNextSchool(ACTIVE_SCHOOL);
});

function probe(schoolId) {
  const req = request(app).get('/api/disputes/probe');
  return schoolId ? req.set('X-School-ID', schoolId) : req;
}

describe('resolveSchool — enumeration oracle closed', () => {
  test('unknown school → 404 NOT_FOUND', async () => {
    setNextSchool(null);
    const res = await probe('SCH-FAKE');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'School not found.', code: 'NOT_FOUND' });
  });

  test('inactive school → identical 404 body (not 403 SCHOOL_INACTIVE)', async () => {
    setNextSchool({ ...ACTIVE_SCHOOL, isActive: false });
    const res = await probe('SCH-GONE');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'School not found.', code: 'NOT_FOUND' });
  });

  test('unknown and inactive are indistinguishable (status + body)', async () => {
    setNextSchool(null);
    const unknown = await probe('SCH-FAKE');
    setNextSchool({ ...ACTIVE_SCHOOL, isActive: false });
    const inactive = await probe('SCH-REAL-BUT-OFF');

    expect(unknown.status).toBe(inactive.status);
    expect(unknown.body).toEqual(inactive.body);
  });

  test('missing headers → 400 MISSING_SCHOOL_CONTEXT', async () => {
    const res = await probe(null);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code', 'MISSING_SCHOOL_CONTEXT');
  });
});

describe('resolveSchool — presented credentials are enforced', () => {
  test('expired token → 401 TOKEN_EXPIRED (not anonymous fall-through)', async () => {
    const expired = jwt.sign(
      { role: 'user', roles: ['staff'], schoolId: 'SCH-ACTIVE', sub: 'u1' },
      process.env.JWT_SECRET,
      { expiresIn: '-1h' }
    );
    const res = await probe('SCH-ACTIVE').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'TOKEN_EXPIRED');
  });

  test('malformed token → 401 INVALID_AUTH_TOKEN', async () => {
    const res = await probe('SCH-ACTIVE').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code', 'INVALID_AUTH_TOKEN');
  });

  test('valid token scoped to another school → 403 TENANT_MISMATCH', async () => {
    // Ensure the resolved school differs from the token's school.
    setNextSchool({ ...ACTIVE_SCHOOL, schoolId: 'SCH-BBB', slug: 'school-bbb' });
    const token = jwt.sign(
      { role: 'user', roles: ['staff'], schoolId: 'SCH-AAA', sub: 'u1' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await probe('SCH-BBB').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('code', 'TENANT_MISMATCH');
  });

  test('valid matching token passes resolution through to the router', async () => {
    const token = jwt.sign(
      { role: 'user', roles: ['staff'], schoolId: 'SCH-ACTIVE', sub: 'u1' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await probe('SCH-ACTIVE').set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test('super-admin cross-school override resolves and is audited', async () => {
    const auditService = require('../backend/src/services/auditService');
    setNextSchool({ ...ACTIVE_SCHOOL, schoolId: 'SCH-BBB', slug: 'school-bbb' });
    const token = jwt.sign(
      { role: 'admin', schoolId: 'SCH-OTHER', sub: 'root' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await probe('SCH-BBB').set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(auditService.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'super_admin_school_override',
        schoolId: 'SCH-BBB',
      })
    );
  });
});
