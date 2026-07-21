'use strict';

/**
 * Tests for issue #887 — Report/receipt routes must be gated behind the
 * finance permission (roles: owner or finance).
 *
 * Strategy: test the auth middleware (requireSchoolAuth) directly against
 * lightweight Express sub-apps that mount only the routes under test.
 * This avoids loading the full app (and its real Mongoose/Redis connections)
 * while still exercising the real route files and real auth middleware.
 *
 * Covers every acceptance criterion:
 *   ✓ Report/export routes require an explicit finance permission.
 *   ✓ Unauthorized roles receive 403.
 *   ✓ Tests cover role enforcement.
 */

process.env.JWT_SECRET            = 'test-secret-finance-role-887';
process.env.MONGO_URI             = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const express   = require('express');
const request   = require('supertest');
const jwt       = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

// ── Minimal mocks needed by auth.js and schoolContext.js ─────────────────────

// auth.js + schoolContext.js use ../cache
jest.mock('../backend/src/cache', () => ({
  get:         jest.fn().mockReturnValue(undefined),
  set:         jest.fn(),
  del:         jest.fn(),
  delByPrefix: jest.fn(),
  KEYS: {
    school:    (id) => `school:${id}`,
    report:    (s, e) => `report:${s || ''}:${e || ''}`,
  },
  TTL: {
    SCHOOL: 300,
    REPORT: 300,
  },
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue({}),
}));

// schoolContext.js does two School.findOne calls (isActive check + full doc)
const SCHOOL_DOC = {
  schoolId:       'school-a',
  name:           'Test School',
  slug:           'school-a',
  stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  isActive:       true,
  timezone:       'UTC',
};

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      schoolId:       'school-a',
      name:           'Test School',
      slug:           'school-a',
      stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      isActive:       true,
      timezone:       'UTC',
    }),
  }),
}));

// reportController uses ../cache and ../services/reportService
jest.mock('../backend/src/services/reportService', () => ({
  generateReport: jest.fn().mockResolvedValue({
    summary: { totalAmount: '0', paymentCount: 0, validCount: 0,
               overpaidCount: 0, underpaidCount: 0, fullyPaidStudentCount: 0 },
    byDate: [], period: {}, generatedAt: new Date().toISOString(),
  }),
  reportToCsv:           jest.fn().mockReturnValue('date,amount\n'),
  getDashboardMetrics:   jest.fn().mockResolvedValue({ totalPayments: 0 }),
  generateAccountingCsv: jest.fn().mockResolvedValue({ csv: '' }),
  getDataVersion:        jest.fn().mockResolvedValue('0'),
  ACCOUNTING_SCHEMA_VERSION: 1,
}));

// receiptsController uses receiptModel
jest.mock('../backend/src/models/receiptModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      txHash:    'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222',
      studentId: 'STU001',
      schoolId:  'school-a',
      amount:    250,
      assetCode: 'XLM',
    }),
  }),
}));

// ── Load the real middleware + routes ─────────────────────────────────────────

const { requireSchoolAuth } = require('../backend/src/middleware/auth');
const reportRoutes  = require('../backend/src/routes/reportRoutes');
const receiptsRoutes = require('../backend/src/routes/receiptsRoutes');

// ── Build minimal test apps ───────────────────────────────────────────────────

function makeApp(routes, mountPath) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(mountPath, routes);
  // Simple error handler so 4xx/5xx don't become unhandled exceptions
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.message, code: err.code || 'ERROR' });
  });
  return app;
}

const reportApp   = makeApp(reportRoutes,  '/api/reports');
const receiptApp  = makeApp(receiptsRoutes, '/api/receipts');

// ── Token helpers ─────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET;
const SCHOOL  = 'school-a';

function tok(roles, schoolId = SCHOOL) {
  return jwt.sign({ schoolId, roles }, SECRET);
}

const superAdminToken = jwt.sign({ role: 'admin' }, SECRET);
const ownerToken      = tok(['owner']);
const financeToken    = tok(['finance']);
const staffToken      = tok(['staff']);
const viewerToken     = tok(['viewer']);
const expiredToken    = jwt.sign({ schoolId: SCHOOL, roles: ['finance'] }, SECRET, { expiresIn: '-1h' });
const badToken        = 'not.a.valid.jwt';

function getReport(path, token, app = reportApp) {
  const req = request(app).get(path).set('X-School-ID', SCHOOL);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

// ── GET /api/reports ──────────────────────────────────────────────────────────

describe('GET /api/reports — finance role enforcement (#887)', () => {
  test('401 — no token', async () => {
    const res = await getReport('/api/reports');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
  });

  test('401 — expired token', async () => {
    const res = await getReport('/api/reports', expiredToken);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('401 — invalid token', async () => {
    const res = await getReport('/api/reports', badToken);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_TOKEN');
  });

  test('403 — "staff" role denied', async () => {
    const res = await getReport('/api/reports', staffToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('403 — "viewer" role denied', async () => {
    const res = await getReport('/api/reports', viewerToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('200 — "finance" role is authorized', async () => {
    const res = await getReport('/api/reports', financeToken);
    expect(res.status).toBe(200);
  });

  test('200 — "owner" role is authorized', async () => {
    const res = await getReport('/api/reports', ownerToken);
    expect(res.status).toBe(200);
  });

  test('200 — super-admin bypass (role:"admin")', async () => {
    const res = await getReport('/api/reports', superAdminToken);
    expect(res.status).toBe(200);
  });
});

// ── GET /api/reports/dashboard ────────────────────────────────────────────────

describe('GET /api/reports/dashboard — finance role enforcement (#887)', () => {
  test('401 — no token', async () => {
    const res = await getReport('/api/reports/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
  });

  test('403 — "staff" role denied', async () => {
    const res = await getReport('/api/reports/dashboard', staffToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('200 — "finance" role is authorized', async () => {
    const res = await getReport('/api/reports/dashboard', financeToken);
    expect(res.status).toBe(200);
  });

  test('200 — "owner" role is authorized', async () => {
    const res = await getReport('/api/reports/dashboard', ownerToken);
    expect(res.status).toBe(200);
  });

  test('200 — super-admin bypass', async () => {
    const res = await getReport('/api/reports/dashboard', superAdminToken);
    expect(res.status).toBe(200);
  });
});

// ── GET /api/reports?format=csv ───────────────────────────────────────────────

describe('GET /api/reports?format=csv — finance role enforcement (#887)', () => {
  test('401 — no token on CSV export', async () => {
    const res = await getReport('/api/reports?format=csv');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
  });

  test('403 — "staff" role denied on CSV export', async () => {
    const res = await getReport('/api/reports?format=csv', staffToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('200 — "finance" role allowed on CSV export', async () => {
    const res = await getReport('/api/reports?format=csv', financeToken);
    expect(res.status).toBe(200);
  });
});

// ── GET /api/receipts/:txHash ─────────────────────────────────────────────────

describe('GET /api/receipts/:txHash — finance role enforcement (#887)', () => {
  const TX = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222';

  function getReceipt(token) {
    return getReport(`/api/receipts/${TX}`, token, receiptApp);
  }

  test('401 — no token', async () => {
    const res = await getReceipt(null);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_AUTH_TOKEN');
  });

  test('401 — expired token', async () => {
    const res = await getReceipt(expiredToken);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('401 — invalid token', async () => {
    const res = await getReceipt(badToken);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_AUTH_TOKEN');
  });

  test('403 — "staff" role denied', async () => {
    const res = await getReceipt(staffToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('403 — "viewer" role denied', async () => {
    const res = await getReceipt(viewerToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });

  test('200 — "finance" role is authorized', async () => {
    const res = await getReceipt(financeToken);
    expect(res.status).toBe(200);
  });

  test('200 — "owner" role is authorized', async () => {
    const res = await getReceipt(ownerToken);
    expect(res.status).toBe(200);
  });

  test('200 — super-admin bypass', async () => {
    const res = await getReceipt(superAdminToken);
    expect(res.status).toBe(200);
  });
});
