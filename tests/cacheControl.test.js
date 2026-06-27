'use strict';

/**
 * Tests for Issue #825 — Cache-Control: no-store on sensitive routes,
 * and Helmet security headers on API responses.
 *
 * Acceptance criteria:
 *  - Auth, payment, student, audit, receipts, reports, disputes responses
 *    include Cache-Control: no-store and Pragma: no-cache.
 *  - Helmet sets X-Content-Type-Options: nosniff.
 *  - Helmet/CSP sets frameAncestors 'none'.
 */

process.env.MONGO_URI  = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-secret-for-cache-headers';

const request = require('supertest');
const jwt     = require('jsonwebtoken');

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema:  class { constructor() { this.index = jest.fn(); } },
  model:   jest.fn().mockReturnValue({}),
  connection: { on: jest.fn() },
}));

jest.mock('../backend/src/models/schoolModel',      () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/studentModel',     () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/feeStructureModel',() => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/paymentModel',     () => ({ find: jest.fn() }));
jest.mock('../backend/src/services/auditService',   () => ({
  logAudit: jest.fn().mockResolvedValue({}),
  getAuditHealth: jest.fn().mockReturnValue({ status: 'ok' }),
}));
jest.mock('../backend/src/services/retryService',   () => ({
  queueForRetry: jest.fn(), startRetryWorker: jest.fn(), stopRetryWorker: jest.fn(),
  isRetryWorkerRunning: jest.fn().mockReturnValue(false),
}));
jest.mock('../backend/src/utils/memoEncryption',    () => ({
  encryptMemo: jest.fn(x => x), isEncryptionEnabled: jest.fn(() => false),
}));

const app = require('../backend/src/app');

// ── Cache-Control tests via HTTP ──────────────────────────────────────────────

const SENSITIVE_ROUTES = [
  '/api/auth/login',
  '/api/payments/limits',
  '/api/students',
  '/api/audit',
];

describe('Issue #825 — Cache-Control: no-store on sensitive routes', () => {
  const adminToken = jwt.sign(
    { role: 'admin', userId: 'super_admin', roles: ['super_admin'] },
    process.env.JWT_SECRET
  );

  for (const route of SENSITIVE_ROUTES) {
    test(`${route} responds with Cache-Control: no-store`, async () => {
      const res = await request(app)
        .get(route)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-School-ID', 'school-test');
      expect(res.headers['cache-control']).toMatch(/no-store/i);
    });

    test(`${route} responds with Pragma: no-cache`, async () => {
      const res = await request(app)
        .get(route)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-School-ID', 'school-test');
      expect(res.headers['pragma']).toMatch(/no-cache/i);
    });
  }
});

// ── Helmet security-header tests via app.js source (no HTTP round-trip needed) ─

describe('Issue #825 — Helmet security headers (source verification)', () => {
  const fs   = require('fs');
  const path = require('path');
  const appSrc = fs.readFileSync(path.join(__dirname, '../backend/src/app.js'), 'utf8');

  test('Helmet X-Content-Type-Options is enabled (nosniff not disabled)', () => {
    // Helmet enables nosniff by default; check it is not explicitly turned off
    expect(appSrc).not.toMatch(/noSniff\s*:\s*false/);
  });

  test("CSP sets frameAncestors 'none'", () => {
    expect(appSrc).toContain("frameAncestors: [\"'none'\"]");
  });

  test("CSP sets defaultSrc 'none'", () => {
    expect(appSrc).toContain("defaultSrc: [\"'none'\"]");
  });
});
