'use strict';

/**
 * Issue #1949 — failed-auth handler must not let an unauthenticated caller
 * write audit rows into a tenant, and must not store or alert on raw client IPs.
 *
 * Exercised through the public requireSchoolAuth middleware with a token that
 * cannot verify, so the real handleAuthFailure path runs.
 */

jest.mock('../src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/models/School', () => ({
  exists: jest.fn(),
}));

jest.mock('../src/models/userModel', () => ({
  findById: jest.fn(),
}));

const { requireSchoolAuth } = require('../src/middleware/auth');
const { logAudit } = require('../src/services/auditService');
const { sendAdminAlert } = require('../src/services/alertService');
const School = require('../src/models/School');
const { hashIp } = require('../src/utils/piiRedaction');
const cache = require('../src/cache');

const RAW_IP = '198.51.100.23';

function makeReq(headers = {}, extra = {}) {
  return {
    headers: { authorization: 'Bearer not.a.real.token', ...headers },
    ip: RAW_IP,
    originalUrl: '/api/students?page=2&token=secret',
    ...extra,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function runMiddleware(req) {
  const res = makeRes();
  const next = jest.fn();
  await requireSchoolAuth()(req, res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Failure counters, blocks and sampling state live in the in-process cache.
  cache.delByPrefix('ip_');
  cache.delByPrefix('auth_missing_audit');
  School.exists.mockResolvedValue(null);
});

describe('Issue #1949 — auth failure audit privacy', () => {
  test('writes the audit row to the system tenant, ignoring an unknown X-School-ID', async () => {
    const { res } = await runMiddleware(makeReq({ 'x-school-id': 'SCH-VICTIM-001' }));

    expect(res.status).toHaveBeenCalledWith(401);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry.schoolId).toBe('system');
    expect(entry.details.claimedSchoolId).toBeUndefined();
  });

  test('keeps X-School-ID only as a claim when that school really exists', async () => {
    School.exists.mockResolvedValue({ _id: 'x' });

    await runMiddleware(makeReq({ 'x-school-id': 'SCH-REAL-001' }));

    const entry = logAudit.mock.calls[0][0];
    expect(entry.schoolId).toBe('system');
    expect(entry.details.claimedSchoolId).toBe('SCH-REAL-001');
  });

  test('never stores the raw client IP in the audit row', async () => {
    await runMiddleware(makeReq());

    const entry = logAudit.mock.calls[0][0];
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(RAW_IP);
    expect(entry.ipAddress).toBe(hashIp(RAW_IP));
    expect(entry.details.ipHash).toBe(hashIp(RAW_IP));
  });

  test('strips the query string from the logged endpoint', async () => {
    await runMiddleware(makeReq());

    const entry = logAudit.mock.calls[0][0];
    expect(entry.details.endpoint).toBe('/api/students');
  });

  test('admin alerts carry the hashed IP only', async () => {
    // Drive the in-process failure counter to its threshold (5 counted failures).
    for (let i = 0; i < 5; i += 1) {
      await runMiddleware(makeReq());
    }

    expect(sendAdminAlert).toHaveBeenCalled();
    for (const [message, details] of sendAdminAlert.mock.calls) {
      expect(message).not.toContain(RAW_IP);
      expect(JSON.stringify(details)).not.toContain(RAW_IP);
    }
  });

  test('samples missing-credential audit writes to one per IP per minute', async () => {
    const noToken = () => makeReq({ authorization: undefined });

    await runMiddleware(noToken());
    await runMiddleware(noToken());
    await runMiddleware(noToken());

    const missing = logAudit.mock.calls.filter(
      ([entry]) => entry.details.code === 'MISSING_AUTH_TOKEN'
    );
    expect(missing).toHaveLength(1);
  });
});
