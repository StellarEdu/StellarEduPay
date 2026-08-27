'use strict';

/**
 * Issue #1175 — GET /api/audit Integration Test
 *
 * Before the fix, auditRoutes was never mounted in app.js and every
 * GET /api/audit request returned 404.  This test verifies:
 *   1. The auditRoutes module mounts without error.
 *   2. A valid school context returns paginated audit log entries.
 *   3. The response envelope has the expected shape.
 *
 * Uses direct controller function calls to avoid pulling in express/supertest,
 * which are only available in backend/node_modules (not root node_modules).
 */

// ── Environment stubs ─────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ── Mock auditService ─────────────────────────────────────────────────────────
const MOCK_AUDIT_LOGS = [
  { _id: 'a1', schoolId: 'SCH-1175', action: 'student_create', result: 'success', createdAt: new Date('2026-01-01') },
  { _id: 'a2', schoolId: 'SCH-1175', action: 'fee_update',     result: 'success', createdAt: new Date('2026-01-02') },
];

jest.mock('../backend/src/services/auditService', () => ({
  logAudit:         jest.fn().mockResolvedValue({}),
  getAuditLogs:     jest.fn().mockResolvedValue({
    logs:  MOCK_AUDIT_LOGS,
    total: 2,
    page:  1,
    limit: 50,
    pages: 1,
  }),
  getRecentAuditLogs: jest.fn().mockResolvedValue(MOCK_AUDIT_LOGS),
  verifyAuditChain:   jest.fn().mockResolvedValue({ valid: true, checkedCount: 2 }),
}));

jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});

// ── Build a minimal req/res/next triple ───────────────────────────────────────

function makeReq(query = {}) {
  return { schoolId: 'SCH-1175', query };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;  return this; },
  };
  return res;
}

const next = jest.fn();

// ── Load controller after mocks ───────────────────────────────────────────────
const {
  getAuditLogsEndpoint,
  getRecentAuditLogsEndpoint,
} = require('../backend/src/controllers/auditController');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#1175 — auditRoutes is mountable and reachable', () => {

  test('auditController module loads without error', () => {
    expect(typeof getAuditLogsEndpoint).toBe('function');
    expect(typeof getRecentAuditLogsEndpoint).toBe('function');
  });

  test('getAuditLogsEndpoint returns 200 with paginated envelope', async () => {
    const req = makeReq();
    const res = makeRes();

    await getAuditLogsEndpoint(req, res, next);

    expect(res._status).toBe(200);
    expect(res._body).toHaveProperty('logs');
    expect(res._body).toHaveProperty('total');
    expect(res._body).toHaveProperty('page');
    expect(res._body).toHaveProperty('limit');
    expect(res._body).toHaveProperty('pages');
    expect(Array.isArray(res._body.logs)).toBe(true);
  });

  test('getAuditLogsEndpoint returns the seeded log entries', async () => {
    const req = makeReq();
    const res = makeRes();

    await getAuditLogsEndpoint(req, res, next);

    expect(res._status).toBe(200);
    expect(res._body.logs).toHaveLength(2);
    expect(res._body.logs[0].action).toBe('student_create');
    expect(res._body.total).toBe(2);
  });

  test('getRecentAuditLogsEndpoint returns an array', async () => {
    const req = makeReq({ limit: '10' });
    const res = makeRes();

    await getRecentAuditLogsEndpoint(req, res, next);

    expect(res._status).toBe(200);
    expect(Array.isArray(res._body)).toBe(true);
  });

  test('getAuditLogs is called with schoolId from request', async () => {
    const { getAuditLogs } = require('../backend/src/services/auditService');
    const req = makeReq({ page: '2', limit: '10' });
    const res = makeRes();

    await getAuditLogsEndpoint(req, res, next);

    expect(getAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH-1175', page: 2, limit: 10 }),
    );
  });

  test('app.js requires and mounts auditRoutes (static source check)', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.resolve(__dirname, '../backend/src/app.js'), 'utf8');

    expect(src).toMatch(/require\(['"]\.\/routes\/auditRoutes['"]\)/);
    expect(src).toMatch(/app\.use\(['"]\/api\/audit['"],\s*auditRoutes\s*\)/);
  });

  test('app.js requires and mounts paymentPlanRoutes (static source check)', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.resolve(__dirname, '../backend/src/app.js'), 'utf8');

    expect(src).toMatch(/require\(['"]\.\/routes\/paymentPlanRoutes['"]\)/);
    expect(src).toMatch(/app\.use\(['"]\/api\/payment-plans['"],\s*paymentPlanRoutes\s*\)/);
  });
});
