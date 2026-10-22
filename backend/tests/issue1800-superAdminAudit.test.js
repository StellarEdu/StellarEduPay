'use strict';

/**
 * Super-admin cross-tenant access audit (#1800).
 *
 * Verifies:
 *   1. The env super-admin token (no schoolId) is audited on every school access.
 *   2. The audited IP is req.ip, not the client-controlled X-Forwarded-For header.
 *   3. performedBy identifies the named principal, not the literal 'super_admin'.
 *   4. Repeated access in the same session/school/hour writes a single entry.
 *   5. Tokens scoped to the same school are not audited.
 */

const jwt = require('jsonwebtoken');
const School = require('../src/models/schoolModel');
const cache = require('../src/cache');
const { logAudit } = require('../src/services/auditService');
const { resolveSchool } = require('../src/middleware/schoolContext');

jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue({}) }));

const SECRET = 'issue1800-test-secret';
const school = {
  _id: '507f1f77bcf86cd799439021',
  schoolId: 'SCH-AUDIT-1800',
  slug: 'audit-1800',
  isActive: true,
  maintenanceMode: false,
};

function makeReq({ token, ip = '192.168.1.10', forwardedFor }) {
  return {
    headers: {
      'x-school-id': school.schoolId,
      authorization: `Bearer ${token}`,
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      'user-agent': 'jest',
    },
    query: {},
    path: '/api/students',
    ip,
    socket: { remoteAddress: '10.0.0.1' },
  };
}

function makeRes() {
  return { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('Super-admin school access audit (#1800)', () => {
  let originalSecret;

  beforeAll(() => {
    originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    logAudit.mockClear();
    jest.spyOn(School, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(school) });
    cache.del(cache.KEYS.school(school.schoolId), cache.KEYS.school(school.slug));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('audits the env super-admin token, which carries no schoolId', async () => {
    const token = jwt.sign(
      { role: 'admin', username: 'ops@platform.test', userId: 'super_admin', roles: ['super_admin'], iat: 1000001 },
      SECRET
    );
    const next = jest.fn();

    await resolveSchool(makeReq({ token }), makeRes(), next);

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      schoolId: school.schoolId,
      action: 'super_admin_school_override',
      performedBy: 'ops@platform.test',
      targetId: school.schoolId,
    });
    expect(next).toHaveBeenCalled();
  });

  it('records req.ip and ignores a forged X-Forwarded-For header', async () => {
    const token = jwt.sign({ role: 'admin', username: 'ops@platform.test', iat: 1000002 }, SECRET);

    await resolveSchool(
      makeReq({ token, ip: '192.168.1.10', forwardedFor: '203.0.113.99, 192.168.1.10' }),
      makeRes(),
      jest.fn()
    );

    const entry = logAudit.mock.calls[0][0];
    expect(entry.ipAddress).toBe('192.168.1.10');
    expect(entry.details.ip).toBe('192.168.1.10');
    expect(entry.ipAddress).not.toBe('203.0.113.99');
  });

  it('attributes the access to the named DB super-admin via userId', async () => {
    const token = jwt.sign(
      { role: 'admin', userId: 'user-42', schoolId: 'SCH-OTHER', iat: 1000003 },
      SECRET
    );

    await resolveSchool(makeReq({ token }), makeRes(), jest.fn());

    expect(logAudit.mock.calls[0][0].performedBy).toBe('user-42');
  });

  it('writes one entry per session, school and hour', async () => {
    const token = jwt.sign({ role: 'admin', username: 'ops@platform.test', jti: 'sess-dedup', iat: 1000004 }, SECRET);

    await resolveSchool(makeReq({ token }), makeRes(), jest.fn());
    await resolveSchool(makeReq({ token }), makeRes(), jest.fn());
    await resolveSchool(makeReq({ token }), makeRes(), jest.fn());

    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('does not audit a token scoped to the same school', async () => {
    const token = jwt.sign(
      { role: 'admin', userId: 'user-7', schoolId: school.schoolId, iat: 1000005 },
      SECRET
    );
    const next = jest.fn();

    await resolveSchool(makeReq({ token }), makeRes(), next);

    expect(logAudit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
