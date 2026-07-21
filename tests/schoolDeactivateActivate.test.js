'use strict';

// Set required env vars before app/config is loaded — config/index.js throws
// without MONGO_URI.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

/**
 * Tests for PATCH /api/schools/:id/deactivate and /activate — issue #453
 */

const { deactivateSchoolEndpoint, activateSchool } = require('../backend/src/controllers/schoolController');

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
const { logAudit } = require('../backend/src/services/auditService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(slug = 'lincoln-high') {
  return {
    params: { schoolSlug: slug },
    body: {},
    headers: {},
    auditContext: { performedBy: 'admin@test.com', ipAddress: '127.0.0.1', userAgent: 'jest' },
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('School deactivate/activate endpoints — issue #453', () => {
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  // ── PATCH /deactivate ──────────────────────────────────────────────────────

  describe('PATCH /api/schools/:id/deactivate', () => {
    it('404 when school not found', async () => {
      School.findOneAndUpdate.mockResolvedValue(null);
      const req = mockReq('unknown-school');
      const res = mockRes();
      await deactivateSchoolEndpoint(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('200 sets isActive: false', async () => {
      const school = { schoolId: 'SCH-001', name: 'Lincoln High', slug: 'lincoln-high', isActive: false };
      School.findOneAndUpdate.mockResolvedValue(school);
      const req = mockReq('lincoln-high');
      const res = mockRes();
      await deactivateSchoolEndpoint(req, res, next);
      expect(School.findOneAndUpdate).toHaveBeenCalledWith(
        { slug: 'lincoln-high' },
        { isActive: false },
        { new: true }
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ isActive: false, schoolId: 'SCH-001' }));
    });

    it('creates audit log with action school_deactivate', async () => {
      const school = { schoolId: 'SCH-001', name: 'Lincoln High', slug: 'lincoln-high', isActive: false };
      School.findOneAndUpdate.mockResolvedValue(school);
      const req = mockReq('lincoln-high');
      const res = mockRes();
      await deactivateSchoolEndpoint(req, res, next);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'school_deactivate',
        targetType: 'school',
        result: 'success',
      }));
    });
  });

  // ── PATCH /activate ────────────────────────────────────────────────────────

  describe('PATCH /api/schools/:id/activate', () => {
    it('404 when school not found', async () => {
      School.findOneAndUpdate.mockResolvedValue(null);
      const req = mockReq('unknown-school');
      const res = mockRes();
      await activateSchool(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('200 sets isActive: true', async () => {
      const school = { schoolId: 'SCH-001', name: 'Lincoln High', slug: 'lincoln-high', isActive: true };
      School.findOneAndUpdate.mockResolvedValue(school);
      const req = mockReq('lincoln-high');
      const res = mockRes();
      await activateSchool(req, res, next);
      expect(School.findOneAndUpdate).toHaveBeenCalledWith(
        { slug: 'lincoln-high' },
        { isActive: true },
        { new: true }
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ isActive: true, schoolId: 'SCH-001' }));
    });

    it('creates audit log with action school_activate', async () => {
      const school = { schoolId: 'SCH-001', name: 'Lincoln High', slug: 'lincoln-high', isActive: true };
      School.findOneAndUpdate.mockResolvedValue(school);
      const req = mockReq('lincoln-high');
      const res = mockRes();
      await activateSchool(req, res, next);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'school_activate',
        targetType: 'school',
        result: 'success',
      }));
    });
  });

  // ── schoolContext rejects inactive schools ─────────────────────────────────

  describe('schoolContext middleware rejects inactive schools', () => {
    it('resolveSchool returns 404 for inactive school', async () => {
      // schoolContext already queries { isActive: true } — simulate not found
      const { resolveSchool } = require('../backend/src/middleware/schoolContext');

      // Return null from findOne (school not found) — lean() chain required by schoolContext
      School.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      const req = { headers: { 'x-school-id': 'SCH-001' } };
      const res = mockRes();
      const nextFn = jest.fn();
      await resolveSchool(req, res, nextFn);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
    });
  });

  // ── Full deactivate → reactivate flow ─────────────────────────────────────

  describe('deactivation and reactivation flow', () => {
    it('deactivate then activate restores isActive: true', async () => {
      const school = { schoolId: 'SCH-001', name: 'Lincoln High', slug: 'lincoln-high' };

      // First call: deactivate
      School.findOneAndUpdate.mockResolvedValueOnce({ ...school, isActive: false });
      const deactivateReq = mockReq('lincoln-high');
      const deactivateRes = mockRes();
      await deactivateSchoolEndpoint(deactivateReq, deactivateRes, next);
      expect(deactivateRes.json).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));

      // Second call: activate
      School.findOneAndUpdate.mockResolvedValueOnce({ ...school, isActive: true });
      const activateReq = mockReq('lincoln-high');
      const activateRes = mockRes();
      await activateSchool(activateReq, activateRes, next);
      expect(activateRes.json).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    });
  });
});
