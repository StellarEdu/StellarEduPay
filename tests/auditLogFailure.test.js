'use strict';

/**
 * #635 — auditService.logAudit failure tracking.
 * Verifies that:
 *  - failures are logged at error level with full details
 *  - _auditFailureCount is incremented on each failure
 *  - getAuditHealth() reflects the failure count
 *  - the primary operation continues (no re-throw)
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockCreate;

jest.mock('../backend/src/models/auditLogModel', () => ({
  create: (...args) => mockCreate(...args),
  // logAudit computes a hash-chain prev via _getPrevHash:
  // findOne().sort().select().lean().bypassTenantScope() — stub the chain so it
  // resolves to null (no previous entry) instead of throwing before create runs.
  findOne: () => ({
    sort: () => ({
      select: () => ({
        lean: () => ({
          bypassTenantScope: () => Promise.resolve(null),
        }),
      }),
    }),
  }),
}));

const mockLoggerError = jest.fn();
jest.mock('../backend/src/utils/logger', () => ({
  error: (...args) => mockLoggerError(...args),
}));

// ── Subject ──────────────────────────────────────────────────────────────────

const { logAudit, getAuditHealth, _resetAuditFailureCount } = require('../backend/src/services/auditService');

// ── Tests ────────────────────────────────────────────────────────────────────

const ENTRY = {
  schoolId: 'SCH-1',
  action: 'student_create',
  performedBy: 'admin@test.com',
  targetId: 'STU001',
  targetType: 'student',
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetAuditFailureCount();
});

describe('logAudit — success path', () => {
  test('creates audit log entry and does not increment failure count', async () => {
    mockCreate = jest.fn().mockResolvedValue({});

    await logAudit(ENTRY);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(getAuditHealth()).toEqual({ status: 'ok', recentFailures: 0 });
  });
});

describe('logAudit — failure path', () => {
  test('does not throw when AuditLog.create rejects', async () => {
    mockCreate = jest.fn().mockRejectedValue(new Error('DB write failed'));

    await expect(logAudit(ENTRY)).resolves.toBeUndefined();
  });

  test('logs error at error level with AUDIT_LOG_FAILURE message', async () => {
    const dbError = new Error('connection lost');
    mockCreate = jest.fn().mockRejectedValue(dbError);

    await logAudit(ENTRY);

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      'AUDIT_LOG_FAILURE',
      expect.objectContaining({ err: dbError })
    );
  });

  test('increments failure count on each failure', async () => {
    mockCreate = jest.fn().mockRejectedValue(new Error('disk full'));

    await logAudit(ENTRY);
    await logAudit(ENTRY);

    expect(getAuditHealth()).toEqual({ status: 'degraded', recentFailures: 2 });
  });

  test('getAuditHealth returns degraded after a failure', async () => {
    mockCreate = jest.fn().mockRejectedValue(new Error('schema error'));

    await logAudit(ENTRY);

    const health = getAuditHealth();
    expect(health.status).toBe('degraded');
    expect(health.recentFailures).toBe(1);
  });

  test('primary operation continues — subsequent logAudit calls still execute', async () => {
    mockCreate = jest.fn()
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue({});

    await logAudit(ENTRY); // fails
    await logAudit(ENTRY); // succeeds

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(getAuditHealth().recentFailures).toBe(1);
  });
});

describe('getAuditHealth', () => {
  test('returns ok with 0 failures initially', () => {
    expect(getAuditHealth()).toEqual({ status: 'ok', recentFailures: 0 });
  });

  test('_resetAuditFailureCount resets counter back to ok', async () => {
    mockCreate = jest.fn().mockRejectedValue(new Error('err'));
    await logAudit(ENTRY);
    expect(getAuditHealth().status).toBe('degraded');

    _resetAuditFailureCount();
    expect(getAuditHealth()).toEqual({ status: 'ok', recentFailures: 0 });
  });
});
