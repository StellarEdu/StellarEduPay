'use strict';

/**
 * Tests for backend/src/middleware/auth.js
 * Issue #63 — API Authentication Layer
 */

const tokenService = require('../backend/src/services/tokenService');

const TEST_SECRET = 'test-secret-for-jest';

// Set JWT_SECRET before requiring the middleware
process.env.JWT_SECRET = TEST_SECRET;

const { requireAdminAuth } = require('../backend/src/middleware/auth');
const auditService = require('../backend/src/services/auditService');

// Mock services
jest.mock('../backend/src/services/auditService');
jest.mock('../backend/src/services/alertService', () => ({
  sendAdminAlert: jest.fn().mockResolvedValue(),
}));

// Minimal Express-like mock helpers
function mockReq(authHeader = '', ip = '1.2.3.4') {
  return { 
    headers: { authorization: authHeader },
    ip,
    originalUrl: '/api/admin/test',
    get: jest.fn().mockReturnValue('mock-user-agent')
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

// #1939 — tokens must be signed the way the server signs them (HKDF key, iss/aud),
// not with the raw secret, or the middleware rejects them.
function makeToken(payload, _secret = TEST_SECRET, options = {}) {
  return tokenService.sign(payload, { expiresIn: options.expiresIn || '1h' }).token;
}

describe('requireAdminAuth middleware', () => {
  let next;

  beforeEach(() => {
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('blocks requests with no Authorization header', async () => {
    const req = mockReq(undefined);
    const res = mockRes();
    await requireAdminAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_AUTH_TOKEN' }));
    expect(next).not.toHaveBeenCalled();
    expect(auditService.logAudit).toHaveBeenCalled();
  });

  it('blocks requests with an invalid token', async () => {
    const req = mockReq('Bearer invalid-token');
    const res = mockRes();
    await requireAdminAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_AUTH_TOKEN' }));
    expect(next).not.toHaveBeenCalled();
    expect(auditService.logAudit).toHaveBeenCalled();
  });

  it('blocks and eventually blocks IP after 5 failures', async () => {
    const req = mockReq('Bearer invalid-token', '1.1.1.1');
    
    // Perform 5 failures
    for (let i = 0; i < 5; i++) {
        const res = mockRes();
        await requireAdminAuth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
    }
    
    // 6th request should be blocked
    const resBlocked = mockRes();
    await requireAdminAuth(req, resBlocked, next);
    expect(resBlocked.status).toHaveBeenCalledWith(429);
    expect(resBlocked.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IP_BLOCKED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows valid admin tokens', async () => {
    const token = makeToken({ role: 'admin', userId: 'super_admin', roles: ['super_admin'] });
    const req = mockReq(`Bearer ${token}`);
    const res = mockRes();
    await requireAdminAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin.role).toBe('admin');
  });
});
