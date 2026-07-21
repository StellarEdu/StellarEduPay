'use strict';

/**
 * Tests for Issue #69 — syncAllPayments uses a distributed lock.
 *
 * Acceptance criteria:
 *   1. Concurrent sync calls for the same school return 409 SYNC_IN_PROGRESS.
 *   2. The lock is cross-process (Redis-backed), not in-memory.
 *   3. After the lock is released a new sync can proceed.
 *
 * We mock the distributed lock module so we can control its behaviour
 * deterministically. The Redis client itself is not exercised here — that is
 * covered by distributedLock.test.js.
 */

// ── Shared mock state ─────────────────────────────────────────────────────────
// Variables must have a 'mock' prefix so jest.mock() hoisted factory can
// reference them (jest lint rule for uninitialized mock variables).
let mockAcquireImpl = jest.fn();
let mockReleaseImpl = jest.fn();

jest.mock('../src/services/distributedLock', () => ({
  acquire: (...args) => mockAcquireImpl(...args),
  release: (...args) => mockReleaseImpl(...args),
  withLock: jest.fn(),
}));

// ── Minimal infrastructure mocks ─────────────────────────────────────────────
jest.mock('../src/models/paymentModel', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/receiptModel', () => ({}));
jest.mock('../src/models/refundModel', () => ({}));
jest.mock('../src/models/reconciliationReportModel', () => ({}));
jest.mock('../src/services/receiptService', () => ({
  createReceipt: jest.fn(),
  verifyReceiptSignature: jest.fn(),
}));
jest.mock('../src/services/stellarService', () => ({
  finalizeConfirmedPayments: jest.fn(),
  syncPaymentsForSchool: jest.fn(async () => ({
    found: 1, new: 1, matched: 0, unmatched: 0, failed: 0,
    alreadyProcessed: 0, failedDetails: [],
  })),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/metrics', () => ({
  syncDurationSeconds: { startTimer: () => jest.fn() },
}));
jest.mock('../src/services/refundService', () => ({
  initiateRefund: jest.fn(),
  getRefundsByPayment: jest.fn(),
  getRefundsBySchool: jest.fn(),
}));
jest.mock('../src/services/reconciliationService', () => ({
  generateReconciliationReport: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

process.env.MONGO_URI = 'mongodb://localhost/test';
process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long';

const { syncAllPayments } = require('../src/controllers/paymentAdminController');

/** Build a minimal Express-like req/res/next triple. */
function buildReq(schoolId = 'school-1') {
  return {
    schoolId,
    school: { schoolId },
    auditContext: null,
    body: {},
  };
}

function buildRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body)  { this.body = body; return this; },
  };
  return res;
}

describe('Issue #69 — syncAllPayments distributed lock', () => {
  beforeEach(() => {
    mockAcquireImpl = jest.fn();
    mockReleaseImpl = jest.fn();
  });

  it('returns 409 SYNC_IN_PROGRESS when the distributed lock is held', async () => {
    // Simulate another replica holding the lock.
    mockAcquireImpl.mockResolvedValue(null);

    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await syncAllPayments(req, res, next);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'SYNC_IN_PROGRESS' });
    // next must NOT have been called — no error, clean 409 response.
    expect(next).not.toHaveBeenCalled();
  });

  it('acquires and releases the distributed lock when proceeding', async () => {
    const token = 'tok-abc123';
    mockAcquireImpl.mockResolvedValue({ token, fencingToken: 1 });
    mockReleaseImpl.mockResolvedValue(true);

    const req = buildReq('school-2');
    const res = buildRes();
    const next = jest.fn();

    await syncAllPayments(req, res, next);

    // Lock was acquired with the correct school-scoped key.
    expect(mockAcquireImpl).toHaveBeenCalledWith(
      expect.stringContaining('school-2'),
      expect.any(Number),
    );
    // Lock was always released (even on success).
    expect(mockReleaseImpl).toHaveBeenCalledWith(
      expect.stringContaining('school-2'),
      token,
    );
    // Sync completed normally.
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ message: 'Sync complete' });
  });

  it('releases the lock even when syncPaymentsForSchool throws', async () => {
    const token = 'tok-err';
    mockAcquireImpl.mockResolvedValue({ token, fencingToken: 1 });
    mockReleaseImpl.mockResolvedValue(true);

    const { syncPaymentsForSchool } = require('../src/services/stellarService');
    syncPaymentsForSchool.mockRejectedValueOnce(new Error('Horizon down'));

    const req = buildReq('school-3');
    const res = buildRes();
    const next = jest.fn();

    await syncAllPayments(req, res, next);

    // next was called with the error (error handler picks it up).
    expect(next).toHaveBeenCalled();
    // But lock was released in finally.
    expect(mockReleaseImpl).toHaveBeenCalledWith(
      expect.stringContaining('school-3'),
      token,
    );
  });

  it('uses separate lock keys for different schools (cross-school isolation)', async () => {
    mockAcquireImpl.mockResolvedValue(null);

    const res1 = buildRes();
    const res2 = buildRes();

    await Promise.all([
      syncAllPayments(buildReq('school-A'), res1, jest.fn()),
      syncAllPayments(buildReq('school-B'), res2, jest.fn()),
    ]);

    const keys = mockAcquireImpl.mock.calls.map(([k]) => k);
    // Each school gets its own lock key.
    const [keyA, keyB] = keys;
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain('school-A');
    expect(keyB).toContain('school-B');
  });

  it('no longer exports an in-memory _syncLocks set', () => {
    // The old implementation exported `_syncLocks` for testing; the distributed
    // version has no such export.
    const adminController = require('../src/controllers/paymentAdminController');
    expect(adminController._syncLocks).toBeUndefined();
  });
});
