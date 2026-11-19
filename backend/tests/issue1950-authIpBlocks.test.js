'use strict';

/**
 * Issue #1950 — auth brute-force blocks are per (IP, credential), not per IP.
 *
 * Covers the acceptance criteria:
 *  - one client sending forged tokens does not block a second client on the same IP;
 *  - a blocked IP is visible to admins and can be cleared;
 *  - tenant mismatches and expired tokens are not counted as brute-force signals;
 *  - TRUSTED_NETWORKS are never blocked;
 *  - blocks respond with Retry-After.
 */

jest.mock('../src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/models/School', () => ({
  exists: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/models/userModel', () => ({
  findById: jest.fn(),
}));

const { requireAdminAuth, requireSchoolAuth } = require('../src/middleware/auth');
const tokenService = require('../src/services/tokenService');
const {
  listAuthIpBlocks,
  clearAuthIpBlocksForIp,
} = require('../src/services/authIpBlockService');
const { hashIp } = require('../src/utils/piiRedaction');
const { authIpBlocksTotal } = require('../src/metrics');
const cache = require('../src/cache');

const SHARED_NAT_IP = '203.0.113.9';
const OTHER_IP = '198.51.100.77';

function forgedError(name = 'JsonWebTokenError') {
  const err = new Error('invalid signature');
  err.name = name;
  return err;
}

// Tokens: "valid-*" verify as an env super-admin; "forged-*" fail verification;
// "expired-*" verify as expired; "school-*" verify as a school-scoped user.
const verifySpy = jest.spyOn(tokenService, 'verify').mockImplementation((token) => {
  if (token.startsWith('valid-')) return { role: 'admin' };
  if (token.startsWith('expired-')) throw forgedError('TokenExpiredError');
  if (token.startsWith('school-')) return { schoolId: 'SCH-A', roles: ['owner'] };
  if (token.startsWith('stale-')) return { schoolId: 'SCH-A', roles: ['super_admin'] };
  throw forgedError();
});

function makeReq(ip, token, headers = {}) {
  return {
    ip,
    originalUrl: '/api/admin/students',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

async function call(ip, token, headers) {
  const res = makeRes();
  const next = jest.fn();
  await requireAdminAuth(makeReq(ip, token, headers), res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  verifySpy.mockClear();
  cache.delByPrefix('ip_');
  cache.delByPrefix('auth_missing_audit');
  delete process.env.TRUSTED_NETWORKS;
});

afterAll(() => {
  verifySpy.mockRestore();
  delete process.env.TRUSTED_NETWORKS;
});

describe('Issue #1950 — per-credential auth blocks', () => {
  test('forged tokens from one client do not block a valid client on the same IP', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { res } = await call(SHARED_NAT_IP, `forged-${i}`);
      expect(res.status).toHaveBeenCalledWith(401);
    }

    const { next, res } = await call(SHARED_NAT_IP, 'valid-admin');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  test('blocks the repeating credential from that IP after five failures', async () => {
    for (let i = 0; i < 5; i += 1) {
      await call(SHARED_NAT_IP, 'forged-repeat');
    }

    const { res, next } = await call(SHARED_NAT_IP, 'forged-repeat');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'IP_BLOCKED' })
    );
    expect(res.set).toHaveBeenCalledWith('Retry-After', '900');
  });

  test('a credential block does not stop the same IP using a valid token', async () => {
    for (let i = 0; i < 5; i += 1) {
      await call(SHARED_NAT_IP, 'forged-repeat');
    }

    const { next } = await call(SHARED_NAT_IP, 'valid-admin');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a whole-IP backstop applies after 100 failures from one IP', async () => {
    for (let i = 0; i < 100; i += 1) {
      await call(OTHER_IP, `forged-spray-${i}`);
    }

    const { res, next } = await call(OTHER_IP, 'valid-admin');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe('Issue #1950 — failures that are not brute-force signals', () => {
  test('expired tokens never create a block', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { res } = await call(OTHER_IP, 'expired-token');
      expect(res.status).toHaveBeenCalledWith(401);
    }
    const { res } = await call(OTHER_IP, 'expired-token');
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  test('tenant mismatches never create a block', async () => {
    // Non-super-admin with a mismatched X-School-ID: rejected with 403 before the
    // failure handler runs, so it is never counted.
    for (let i = 0; i < 10; i += 1) {
      const res = makeRes();
      await requireSchoolAuth(['owner'])(
        makeReq(OTHER_IP, 'school-scoped', { 'x-school-id': 'SCH-B' }),
        res,
        jest.fn()
      );
      expect(res.status).toHaveBeenCalledWith(403);
    }

    // Super-admin-role token with a stale school selection: takes the audited 401
    // path (TENANT_MISMATCH). It must still not count towards a block.
    for (let i = 0; i < 10; i += 1) {
      const res = makeRes();
      await requireSchoolAuth(['owner'])(
        makeReq(OTHER_IP, 'stale-super', { 'x-school-id': 'SCH-B' }),
        res,
        jest.fn()
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenLastCalledWith(
        expect.objectContaining({ code: 'TENANT_MISMATCH' })
      );
    }

    const res = makeRes();
    await requireSchoolAuth(['owner'])(
      makeReq(OTHER_IP, 'stale-super', { 'x-school-id': 'SCH-B' }),
      res,
      jest.fn()
    );
    expect(res.status).not.toHaveBeenCalledWith(429);
  });
});

describe('Issue #1950 — trusted networks and admin visibility', () => {
  test('clients inside TRUSTED_NETWORKS are never blocked', async () => {
    process.env.TRUSTED_NETWORKS = '203.0.113.0/24';

    for (let i = 0; i < 120; i += 1) {
      await call(SHARED_NAT_IP, `forged-trusted-${i}`);
    }

    const { next, res } = await call(SHARED_NAT_IP, 'valid-admin');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  test('listing exposes hashed IPs only and clearing lifts the block', async () => {
    for (let i = 0; i < 5; i += 1) {
      await call(SHARED_NAT_IP, 'forged-listed');
    }

    const blocks = await listAuthIpBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(expect.objectContaining({
      ipHash: hashIp(SHARED_NAT_IP),
      kind: 'credential',
    }));
    expect(JSON.stringify(blocks)).not.toContain(SHARED_NAT_IP);

    const cleared = await clearAuthIpBlocksForIp(hashIp(SHARED_NAT_IP));
    expect(cleared).toBe(1);

    const { next } = await call(SHARED_NAT_IP, 'forged-listed');
    expect(next).not.toHaveBeenCalled();
    expect(await listAuthIpBlocks()).toHaveLength(0);
  });

  test('applying a block increments auth_ip_blocks_total by kind', async () => {
    const incSpy = jest.spyOn(authIpBlocksTotal, 'inc');
    try {
      for (let i = 0; i < 5; i += 1) {
        await call(OTHER_IP, 'forged-metric');
      }
      expect(incSpy).toHaveBeenCalledWith({ kind: 'credential' });
    } finally {
      incSpy.mockRestore();
    }
  });
});
