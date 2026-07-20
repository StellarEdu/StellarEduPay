'use strict';

/**
 * Tests for the payment limits admin endpoints (#1117).
 *
 * The audit-log assertions are the point: limits are a fraud control, and the
 * acceptance criteria require every change to be attributable. A change that
 * lands without an audit entry is the failure mode worth guarding.
 */

jest.mock('../src/services/paymentLimitsService', () => ({
  resolveLimits: jest.fn(),
  getStoredLimits: jest.fn(),
  setSystemLimits: jest.fn(),
  setSchoolLimits: jest.fn(),
  clearSchoolLimits: jest.fn(),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));

const svc = require('../src/services/paymentLimitsService');
const { logAudit } = require('../src/services/auditService');
const { getLimits, updateLimits, deleteSchoolLimits } = require('../src/controllers/paymentLimitsAdminController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function mockReq(overrides = {}) {
  return {
    query: {}, body: {}, params: {},
    user: { email: 'admin@school.test' },
    ip: '203.0.113.7',
    get: () => 'jest',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  svc.getStoredLimits.mockResolvedValue({ system: null, school: null, env: { min: 0.01, max: 100000 } });
  svc.resolveLimits.mockResolvedValue({ min: 0.01, max: 100000, source: 'env' });
});

describe('GET /api/admin/payment-limits', () => {
  test('returns effective limits with the layer that supplied them', async () => {
    svc.resolveLimits.mockResolvedValue({ min: 1, max: 500, source: 'system:default' });
    const res = mockRes();
    await getLimits(mockReq(), res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.effective).toMatchObject({ min: 1, max: 500, source: 'system:default' });
    expect(body.scope).toBe('__global__');
  });

  test('scopes to a school when schoolId is supplied', async () => {
    const res = mockRes();
    await getLimits(mockReq({ query: { schoolId: 'SCH001', asset: 'USDC' } }), res, jest.fn());

    expect(svc.resolveLimits).toHaveBeenCalledWith({ schoolId: 'SCH001', asset: 'USDC' });
    expect(res.json.mock.calls[0][0].scope).toBe('SCH001');
  });
});

describe('PUT /api/admin/payment-limits', () => {
  test('updates global limits without a redeployment', async () => {
    const doc = { default: { min: 1, max: 500 } };
    svc.setSystemLimits.mockResolvedValue(doc);

    const res = mockRes();
    await updateLimits(mockReq({ body: doc }), res, jest.fn());

    expect(svc.setSystemLimits).toHaveBeenCalledWith(doc);
    expect(res.json).toHaveBeenCalledWith({ scope: '__global__', stored: doc });
  });

  test('audit-logs the change with before and after values', async () => {
    svc.getStoredLimits.mockResolvedValue({
      system: { default: { min: 0.01, max: 100000 } }, school: null, env: {},
    });
    const after = { default: { min: 1, max: 500 } };
    svc.setSystemLimits.mockResolvedValue(after);

    await updateLimits(mockReq({ body: after }), mockRes(), jest.fn());

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PAYMENT_LIMITS_UPDATED',
      performedBy: 'admin@school.test',
      targetType: 'PaymentLimits',
      severity: 'high',
      ipAddress: '203.0.113.7',
      details: expect.objectContaining({
        scope: 'global',
        before: { default: { min: 0.01, max: 100000 } },
        after,
      }),
    }));
  });

  test('routes a school-scoped update to the school write path', async () => {
    const doc = { default: { min: 2, max: 50 } };
    svc.setSchoolLimits.mockResolvedValue(doc);

    const res = mockRes();
    await updateLimits(mockReq({ body: { schoolId: 'SCH001', ...doc } }), res, jest.fn());

    expect(svc.setSchoolLimits).toHaveBeenCalledWith('SCH001', doc);
    expect(svc.setSystemLimits).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].scope).toBe('SCH001');
  });

  test('rejects an invalid document with 400 and audits the attempt', async () => {
    svc.setSystemLimits.mockRejectedValue(
      Object.assign(new Error('default: max must be greater than min'), { code: 'INVALID_PAYMENT_LIMITS' }),
    );

    const res = mockRes();
    await updateLimits(mockReq({ body: { default: { min: 10, max: 1 } } }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    // A run of malformed writes against a security control is itself a signal.
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PAYMENT_LIMITS_UPDATE_REJECTED',
      result: 'failure',
    }));
  });

  test('returns 404 for an unknown school', async () => {
    svc.setSchoolLimits.mockRejectedValue(
      Object.assign(new Error('School NOPE not found'), { code: 'NOT_FOUND' }),
    );

    const res = mockRes();
    await updateLimits(mockReq({ body: { schoolId: 'NOPE', default: { min: 1, max: 2 } } }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('passes unexpected errors to the error handler rather than swallowing them', async () => {
    svc.setSystemLimits.mockRejectedValue(new Error('mongo down'));
    const next = jest.fn();
    await updateLimits(mockReq({ body: { default: { min: 1, max: 2 } } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'mongo down' }));
  });
});

describe('DELETE /api/admin/payment-limits/:schoolId', () => {
  test('clears the override and audit-logs the previous value', async () => {
    svc.getStoredLimits.mockResolvedValue({
      system: null, school: { default: { min: 2, max: 50 } }, env: {},
    });

    const res = mockRes();
    await deleteSchoolLimits(mockReq({ params: { schoolId: 'SCH001' } }), res, jest.fn());

    expect(svc.clearSchoolLimits).toHaveBeenCalledWith('SCH001');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PAYMENT_LIMITS_CLEARED',
      details: { before: { default: { min: 2, max: 50 } } },
    }));
    expect(res.json).toHaveBeenCalledWith({ scope: 'SCH001', cleared: true });
  });
});
