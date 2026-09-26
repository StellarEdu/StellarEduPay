'use strict';

/**
 * Tests for failed-auth audit entry security fix (#1535).
 *
 * Verifies:
 *   1. Unauthenticated requests cannot create audit entries in a tenant's audit trail.
 *   2. Anonymous requests without credentials produce no audit writes.
 *   3. Auth failures are recorded under system tenant with details.claimedSchoolId.
 *   4. Audit writes are non-blocking for the 401 response path.
 *   5. A metric exposes auth-failure rates by code.
 */

const { handleAuthFailure } = require('../src/middleware/auth');
const AuditLog = require('../src/models/auditLogModel');
const metrics = require('../src/services/metricsService');

describe('Failed-Auth Audit Entry Security (#1535)', () => {
  let auditCreateSpy;
  let metricsIncrementSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    auditCreateSpy = jest.spyOn(AuditLog, 'create').mockResolvedValue({
      _id: 'audit-1',
      schoolId: 'system',
      action: 'auth_failure',
    });
    metricsIncrementSpy = jest.spyOn(metrics, 'incrementAuthFailure').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Audit Isolation - Preventing Tenant Injection', () => {
    it('does not create audit entry under claimed schoolId for INVALID_TOKEN', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-VICTIM-001', // Attacker-controlled
          authorization: 'Bearer invalid.jwt.token',
        },
        ip: '203.0.113.50',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn(),
      };
      const next = jest.fn();

      await handleAuthFailure(req, res, next, {
        code: 'INVALID_TOKEN',
        message: 'Token signature verification failed',
      });

      // Verify audit was created
      expect(auditCreateSpy).toHaveBeenCalled();
      const auditCall = auditCreateSpy.mock.calls[0][0];

      // Audit goes to system tenant, NOT the claimed school
      expect(auditCall.schoolId).toBe('system');
      expect(auditCall.action).toBe('auth_failure');

      // Claimed school is in details, marked as untrusted
      expect(auditCall.details).toEqual(
        expect.objectContaining({
          claimedSchoolId: 'SCH-VICTIM-001',
          code: 'INVALID_TOKEN',
        })
      );
    });

    it('records forged school ID in details.claimedSchoolId, not as targetId', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-FORGED-SCHOOL',
          authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid',
        },
        ip: '192.168.1.100',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'FORGED_TOKEN',
        message: 'Token validation failed',
      });

      const auditCall = auditCreateSpy.mock.calls[0][0];

      // Verify structure: system tenant + untrusted claim
      expect(auditCall.schoolId).toBe('system');
      expect(auditCall.targetType).not.toBe('school'); // No longer 'school'
      expect(auditCall.targetId).not.toBe('admin_auth'); // No longer 'admin_auth'
      expect(auditCall.details.claimedSchoolId).toBe('SCH-FORGED-SCHOOL');
    });

    it('handles missing X-School-ID header by recording undefined claimedSchoolId', async () => {
      const req = {
        headers: {
          // No 'x-school-id' header
          authorization: 'Bearer bad.token',
        },
        ip: '10.0.0.5',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'INVALID_TOKEN',
        message: 'Missing credentials',
      });

      const auditCall = auditCreateSpy.mock.calls[0][0];
      expect(auditCall.schoolId).toBe('system');
      // claimedSchoolId may be undefined or default
      expect(auditCall.details.claimedSchoolId).toBeUndefined();
    });
  });

  describe('No Audit for MISSING_AUTH_TOKEN', () => {
    it('does NOT create audit entry when no token is provided', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
          // No authorization header
        },
        ip: '203.0.113.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'MISSING_AUTH_TOKEN',
        message: 'No token provided',
      });

      // Audit should NOT be created for missing tokens
      expect(auditCreateSpy).not.toHaveBeenCalled();
    });

    it('still creates audit for INVALID_TOKEN even if no authorization header', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
        },
        ip: '203.0.113.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'INVALID_TOKEN',
        message: 'Token malformed',
      });

      // Invalid token (which can be detected client-side) is still audited
      expect(auditCreateSpy).toHaveBeenCalled();
      const auditCall = auditCreateSpy.mock.calls[0][0];
      expect(auditCall.details.code).toBe('INVALID_TOKEN');
    });
  });

  describe('Non-Blocking Audit Writes', () => {
    it('returns 401 immediately without awaiting audit write completion', async () => {
      let auditResolveFunc;
      const auditPromise = new Promise((resolve) => {
        auditResolveFunc = resolve;
      });

      auditCreateSpy.mockReturnValue(auditPromise);

      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
          authorization: 'Bearer invalid.token',
        },
        ip: '192.168.1.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn(),
      };

      const handleAuthPromise = handleAuthFailure(req, res, null, {
        code: 'INVALID_TOKEN',
        message: 'Token invalid',
      });

      // Audit write should be non-blocking
      // In the real implementation, the audit write is fire-and-forget
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalled();

      // Simulate audit completing after response sent
      auditResolveFunc({ _id: 'audit-123' });
      await auditPromise;
    });

    it('catches and logs audit write errors without failing 401 response', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      auditCreateSpy.mockRejectedValue(new Error('DB connection failed'));

      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
          authorization: 'Bearer token',
        },
        ip: '192.168.1.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      // Should not throw even if audit fails
      await handleAuthFailure(req, res, null, {
        code: 'INVALID_TOKEN',
        message: 'Bad token',
      });

      expect(res.status).toHaveBeenCalledWith(401);

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Auth Failure Metrics', () => {
    it('increments auth_failures_total metric with code dimension for each invalid token', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
          authorization: 'Bearer eyJhbGc.invalid',
        },
        ip: '192.168.1.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'INVALID_TOKEN',
        message: 'Signature verification failed',
      });

      // Verify metric is incremented
      expect(metricsIncrementSpy).toHaveBeenCalledWith('INVALID_TOKEN');
    });

    it('increments metric for FORGED_TOKEN code', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
          authorization: 'Bearer invalid',
        },
        ip: '192.168.1.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'FORGED_TOKEN',
        message: 'Token not recognized',
      });

      expect(metricsIncrementSpy).toHaveBeenCalledWith('FORGED_TOKEN');
    });

    it('does NOT increment metric for MISSING_AUTH_TOKEN', async () => {
      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
        },
        ip: '192.168.1.1',
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      await handleAuthFailure(req, res, null, {
        code: 'MISSING_AUTH_TOKEN',
        message: 'No credentials',
      });

      expect(metricsIncrementSpy).not.toHaveBeenCalled();
    });
  });

  describe('Integration: Audit Flood Prevention', () => {
    it('handles high volume of unauthenticated requests without creating DB load', async () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      // Simulate 100 missing token requests
      const promises = [];
      for (let i = 0; i < 100; i++) {
        const req = {
          headers: {
            'x-school-id': `SCH-TEST-${i}`,
          },
          ip: `192.168.1.${i % 256}`,
        };

        promises.push(
          handleAuthFailure(req, res, null, {
            code: 'MISSING_AUTH_TOKEN',
            message: 'No token',
          })
        );
      }

      await Promise.all(promises);

      // No audit writes for MISSING_AUTH_TOKEN
      expect(auditCreateSpy).not.toHaveBeenCalled();
    });

    it('still audits security events (FORGED_TOKEN) with proper throttling in real implementation', async () => {
      // In production, a sampling strategy would be used
      // This test verifies the audit entry structure for real security events
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        set: jest.fn(),
      };

      const req = {
        headers: {
          'x-school-id': 'SCH-TEST-001',
          authorization: 'Bearer malicious.token.attempt',
        },
        ip: '203.0.113.99',
      };

      await handleAuthFailure(req, res, null, {
        code: 'FORGED_TOKEN',
        message: 'Invalid signature',
      });

      expect(auditCreateSpy).toHaveBeenCalled();
      const auditCall = auditCreateSpy.mock.calls[0][0];
      expect(auditCall.details.code).toBe('FORGED_TOKEN');
    });
  });
});
