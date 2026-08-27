'use strict';

/**
 * Tests for GET /api/schools isActive filtering — issue #455
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const jwt = require('jsonwebtoken');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSchools = [
  { schoolId: 'SCH-001', name: 'Active School', slug: 'active-school', isActive: true },
  { schoolId: 'SCH-002', name: 'Inactive School', slug: 'inactive-school', isActive: false },
];

jest.mock('../backend/src/models/schoolModel', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const School = require('../backend/src/models/schoolModel');
const { getAllSchools } = require('../backend/src/controllers/schoolController');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(query = {}, authHeader = undefined) {
  return {
    query,
    headers: authHeader ? { authorization: authHeader } : {},
    body: {},
    params: {},
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function adminToken() {
  return `Bearer ${jwt.sign({ role: 'admin', email: 'admin@test.com' }, 'test-secret', { expiresIn: '1h' })}`;
}

function userToken() {
  return `Bearer ${jwt.sign({ role: 'user', email: 'user@test.com' }, 'test-secret', { expiresIn: '1h' })}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/schools — isActive filtering (issue #455)', () => {
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    School.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn() }) });
  });

  it('default response excludes inactive schools', async () => {
    const activeOnly = mockSchools.filter(s => s.isActive);
    School.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(activeOnly) }) });

    const req = mockReq();
    const res = mockRes();
    await getAllSchools(req, res, next);

    expect(School.find).toHaveBeenCalledWith({ isActive: true });
    expect(res.json).toHaveBeenCalledWith(activeOnly);
  });

  it('?includeInactive=true without auth returns 401', async () => {
    const req = mockReq({ includeInactive: 'true' });
    const res = mockRes();
    await getAllSchools(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_AUTH_TOKEN' }));
  });

  it('?includeInactive=true with non-admin token returns 403', async () => {
    const req = mockReq({ includeInactive: 'true' }, userToken());
    const res = mockRes();
    await getAllSchools(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
  });

  it('?includeInactive=true with invalid token returns 401', async () => {
    const req = mockReq({ includeInactive: 'true' }, 'Bearer not.a.valid.token');
    const res = mockRes();
    await getAllSchools(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_AUTH_TOKEN' }));
  });

  it('?includeInactive=true with admin token returns all schools', async () => {
    School.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockSchools) }) });

    const req = mockReq({ includeInactive: 'true' }, adminToken());
    const res = mockRes();
    await getAllSchools(req, res, next);

    expect(School.find).toHaveBeenCalledWith({});
    expect(res.json).toHaveBeenCalledWith(mockSchools);
  });

  it('?includeInactive=false behaves like default (active only)', async () => {
    const activeOnly = mockSchools.filter(s => s.isActive);
    School.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(activeOnly) }) });

    const req = mockReq({ includeInactive: 'false' });
    const res = mockRes();
    await getAllSchools(req, res, next);

    expect(School.find).toHaveBeenCalledWith({ isActive: true });
  });
});
