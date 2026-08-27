'use strict';

// Test that requireSchoolAuth accepts schoolId from query parameters
// to enable EventSource (which cannot send custom headers like X-School-ID)

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const jwt = require('jsonwebtoken');
const { requireSchoolAuth } = require('../backend/src/middleware/auth');

describe('requireSchoolAuth with query parameter schoolId', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockReq = {
      headers: {},
      params: {},
      query: {},
      ip: '127.0.0.1',
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  it('accepts schoolId from query parameter', () => {
    const token = jwt.sign({ schoolId: 'school-123', roles: ['owner'] }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.query.schoolId = 'school-123';

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('accepts schoolId from X-School-ID header (existing behavior)', () => {
    const token = jwt.sign({ schoolId: 'school-123', roles: ['owner'] }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.headers['x-school-id'] = 'school-123';

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('accepts schoolId from route params (existing behavior)', () => {
    const token = jwt.sign({ schoolId: 'school-123', roles: ['owner'] }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.params.schoolId = 'school-123';

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('rejects when query schoolId does not match token schoolId', () => {
    const token = jwt.sign({ schoolId: 'school-123', roles: ['owner'] }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.query.schoolId = 'school-456'; // Different from token

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Token schoolId does not match'),
        code: 'TENANT_MISMATCH',
      })
    );
  });

  it('prioritizes header over query param when both present', () => {
    const token = jwt.sign({ schoolId: 'school-123', roles: ['owner'] }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.headers['x-school-id'] = 'school-123';
    mockReq.query.schoolId = 'school-456'; // Should be ignored

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('prioritizes header over route param when both present', () => {
    const token = jwt.sign({ schoolId: 'school-123', roles: ['owner'] }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.headers['x-school-id'] = 'school-123';
    mockReq.params.schoolId = 'school-456'; // Should be ignored

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('allows super-admin to bypass schoolId check', () => {
    const token = jwt.sign({ role: 'admin', email: 'super@test.com' }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.query.schoolId = 'any-school'; // Should be ignored for super-admin

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('allows super-admin with roles array to bypass schoolId check', () => {
    const token = jwt.sign({ roles: ['super_admin'], email: 'super@test.com' }, process.env.JWT_SECRET);
    mockReq.headers.authorization = `Bearer ${token}`;
    mockReq.query.schoolId = 'any-school'; // Should be ignored for super-admin

    const middleware = requireSchoolAuth();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
