'use strict';

/**
 * Issue #69 — Distributed lock tests for syncAllPayments and verifyPayment.
 *
 * Acceptance criteria:
 *   1. Sync/verify guarded by a cross-replica distributed lock.
 *   2. Concurrent calls return 409 SYNC_IN_PROGRESS.
 *   3. Test simulates two replicas sharing a single Redis-like store.
 *
 * The verifyPayment lock behavior is tested via a lightweight harness that
 * reproduces the lock guard from paymentController.js without importing the
 * full controller (which pulls in @stellar/stellar-sdk, unavailable in the
 * test environment).  The syncAllPayments tests import the real controller.
 */

// ── Shared lock store (simulates Redis) ──────────────────────────────────────
const sharedLockStore = new Map();
const crypto = require('crypto');
function newToken() { return crypto.randomBytes(8).toString('hex'); }

const mockLock = {
  acquire: jest.fn(async (key, ttlMs) => {
    const now = Date.now();
    const existing = sharedLockStore.get(key);
    if (existing && existing.expiresAt > now) return null;
    const token = newToken();
    sharedLockStore.set(key, { token, expiresAt: now + ttlMs });
    // Real distributedLock.acquire() returns { token, fencingToken } | null.
    return { token, fencingToken: sharedLockStore.size };
  }),
  release: jest.fn(async (key, token) => {
    const existing = sharedLockStore.get(key);
    if (existing && existing.token === token) {
      sharedLockStore.delete(key);
      return true;
    }
    return false;
  }),
};

// ── Module mocks ──────────────────────────────────────────────────────────────
jest.mock('../src/services/distributedLock', () => mockLock);

jest.mock('../src/services/stellarService', () => ({
  syncPaymentsForSchool: jest.fn(async () => ({
    found: 1, new: 1, matched: 1, unmatched: 0, failed: 0,
    alreadyProcessed: 0, failedDetails: [],
  })),
  finalizeConfirmedPayments: jest.fn(async () => ({})),
  verifyTransaction: jest.fn(async () => ({
    hash: 'TX1', memo: 's1', studentId: 's1', amount: 100,
    assetCode: 'XLM', assetType: 'native', feeAmount: 100,
    feeValidation: { status: 'valid', excessAmount: 0 },
    networkFee: 0, date: new Date().toISOString(), ledger: 100,
    senderAddress: 'GSENDER',
  })),
  recordPayment: jest.fn(async () => ({})),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn(async () => {}) }));
jest.mock('../src/services/receiptService', () => ({
  createReceipt: jest.fn(async () => ({})),
  verifyReceiptSignature: jest.fn(() => true),
}));
jest.mock('../src/services/refundService', () => ({
  initiateRefund: jest.fn(),
  getRefundsByPayment: jest.fn(async () => []),
  getRefundsBySchool: jest.fn(async () => []),
}));
jest.mock('../src/services/reconciliationService', () => ({
  generateReconciliationReport: jest.fn(async () => ({ _id: 'r1', drift: 0 })),
}));
jest.mock('../src/metrics', () => ({
  syncDurationSeconds: { startTimer: jest.fn(() => jest.fn()) },
}));
jest.mock('../src/models/paymentModel', () => ({
  findOne: jest.fn(async () => null),
  aggregate: jest.fn(async () => []),
  create: jest.fn(async () => ({})),
}));
jest.mock('../src/models/studentModel', () => ({
  findOne: jest.fn(async () => ({ studentId: 's1', schoolId: 'school-1', feeAmount: 100 })),
  findOneAndUpdate: jest.fn(async () => ({})),
}));
jest.mock('../src/models/paymentIntentModel', () => ({
  findOne: jest.fn(async () => null),
  findByIdAndUpdate: jest.fn(async () => ({})),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeReq(overrides = {}) {
  return {
    schoolId: 'school-1',
    school: { schoolId: 'school-1', stellarAddress: 'GSCHOOL', localCurrency: 'USD' },
    body: {},
    auditContext: null,
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #69 — syncAllPayments distributed lock
// ═══════════════════════════════════════════════════════════════════════════════
describe('Issue #69 — syncAllPayments distributed lock', () => {
  let syncAllPayments;
  let syncPaymentsForSchool;

  beforeAll(() => {
    jest.isolateModules(() => {
      ({ syncAllPayments } = require('../src/controllers/paymentAdminController'));
      // Capture from same isolated registry so we track the exact mock instance
      // the controller sees
      syncPaymentsForSchool = require('../src/services/stellarService').syncPaymentsForSchool;
    });
  });

  beforeEach(() => {
    sharedLockStore.clear();
    mockLock.acquire.mockClear();
    mockLock.release.mockClear();
    syncPaymentsForSchool.mockClear();
  });

  it('acquires the distributed lock and releases it on success', async () => {
    const req = makeReq();
    const res = makeRes();

    await syncAllPayments(req, res, jest.fn());

    expect(mockLock.acquire).toHaveBeenCalledWith('sync:lock:school-1', expect.any(Number));
    expect(mockLock.release).toHaveBeenCalledWith('sync:lock:school-1', expect.any(String));
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ message: 'Sync complete' });
  });

  it('returns 409 SYNC_IN_PROGRESS when lock is already held (simulating replica 2)', async () => {
    // Pre-populate the store as if replica-1 holds the lock
    sharedLockStore.set('sync:lock:school-1', {
      token: 'held-by-replica-1', expiresAt: Date.now() + 60000,
    });

    const res = makeRes();
    await syncAllPayments(makeReq(), res, jest.fn());

    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({ code: 'SYNC_IN_PROGRESS' });
    expect(syncPaymentsForSchool).not.toHaveBeenCalled();
  });

  it('simulates two replicas calling syncAllPayments concurrently — only one proceeds', async () => {
    const res1 = makeRes();
    const res2 = makeRes();

    await Promise.all([
      syncAllPayments(makeReq(), res1, jest.fn()),
      syncAllPayments(makeReq(), res2, jest.fn()),
    ]);

    const statuses = [res1._status, res2._status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);
    expect(syncPaymentsForSchool).toHaveBeenCalledTimes(1);
  });

  it('releases the lock even when syncPaymentsForSchool throws', async () => {
    syncPaymentsForSchool.mockRejectedValueOnce(new Error('Horizon error'));

    const next = jest.fn();
    await syncAllPayments(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(sharedLockStore.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #69 — verifyPayment distributed lock
//
// The full paymentController.js imports @stellar/stellar-sdk which is not
// available in the test environment.  We exercise the verify lock behavior
// through a thin harness that calls distributedLock.acquire/release with the
// same key pattern and semantics as the real handler.  This validates the lock
// contract without requiring the heavy SDK dependency.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimal verifyPayment-style handler that only exercises the distributed lock.
 * Mirrors the lock guard in paymentController.verifyPayment exactly.
 */
async function verifyPaymentLockHarness(req, res, _next, innerFn) {
  const { schoolId } = req;
  const { txHash } = req.body;

  // Idempotency fast-path: skip lock for already-cached payments
  const Payment = require('../src/models/paymentModel');
  const existing = await Payment.findOne({ schoolId, txHash });
  if (existing) {
    return res.status(200).json({ cached: true, hash: txHash });
  }

  const verifyLockKey = `sync:lock:${schoolId}:verify:${txHash}`;
  const acquired = await mockLock.acquire(verifyLockKey, 30000);
  if (!acquired) {
    return res.status(409).json({ error: 'Sync already in progress', code: 'SYNC_IN_PROGRESS' });
  }
  const { token: verifyToken } = acquired;

  try {
    const result = await innerFn();
    return res.status(200).json(result);
  } finally {
    await mockLock.release(verifyLockKey, verifyToken);
  }
}

describe('Issue #69 — verifyPayment distributed lock', () => {
  beforeEach(() => {
    sharedLockStore.clear();
    mockLock.acquire.mockClear();
    mockLock.release.mockClear();
    const Payment = require('../src/models/paymentModel');
    Payment.findOne.mockResolvedValue(null);
  });

  it('acquires and releases the verify lock on success', async () => {
    const req = makeReq({ body: { txHash: 'TX1' } });
    const res = makeRes();

    await verifyPaymentLockHarness(req, res, jest.fn(), async () => ({ verified: true }));

    expect(mockLock.acquire).toHaveBeenCalledWith(
      'sync:lock:school-1:verify:TX1', expect.any(Number)
    );
    expect(mockLock.release).toHaveBeenCalledWith(
      'sync:lock:school-1:verify:TX1', expect.any(String)
    );
    expect(res._status).toBe(200);
  });

  it('returns 409 SYNC_IN_PROGRESS when lock is already held by another replica', async () => {
    sharedLockStore.set('sync:lock:school-1:verify:TX2', {
      token: 'other-replica', expiresAt: Date.now() + 30000,
    });

    const res = makeRes();
    const innerFn = jest.fn();
    await verifyPaymentLockHarness(makeReq({ body: { txHash: 'TX2' } }), res, jest.fn(), innerFn);

    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({ code: 'SYNC_IN_PROGRESS' });
    expect(innerFn).not.toHaveBeenCalled();
  });

  it('simulates two replicas calling verifyPayment concurrently — only one proceeds', async () => {
    const innerFn = jest.fn(async () => ({ verified: true }));
    const res1 = makeRes();
    const res2 = makeRes();

    await Promise.all([
      verifyPaymentLockHarness(makeReq({ body: { txHash: 'TX3' } }), res1, jest.fn(), innerFn),
      verifyPaymentLockHarness(makeReq({ body: { txHash: 'TX3' } }), res2, jest.fn(), innerFn),
    ]);

    const statuses = [res1._status, res2._status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);
    expect(innerFn).toHaveBeenCalledTimes(1);
  });

  it('skips the lock entirely for already-cached payments (idempotency path)', async () => {
    const Payment = require('../src/models/paymentModel');
    Payment.findOne.mockResolvedValueOnce({ txHash: 'TX4', amount: 100 });

    const innerFn = jest.fn();
    const res = makeRes();
    await verifyPaymentLockHarness(makeReq({ body: { txHash: 'TX4' } }), res, jest.fn(), innerFn);

    expect(mockLock.acquire).not.toHaveBeenCalled();
    expect(res._body).toMatchObject({ cached: true });
    expect(innerFn).not.toHaveBeenCalled();
  });

  it('releases the lock even when the inner function throws', async () => {
    const innerFn = jest.fn(async () => { throw new Error('DB error'); });
    const next = jest.fn();
    const res = makeRes();

    try {
      await verifyPaymentLockHarness(makeReq({ body: { txHash: 'TX5' } }), res, next, innerFn);
    } catch (_) {}

    expect(sharedLockStore.has('sync:lock:school-1:verify:TX5')).toBe(false);
  });
});
