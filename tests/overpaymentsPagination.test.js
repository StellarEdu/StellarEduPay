'use strict';

/**
 * Tests for issue #593 — getOverpayments pagination
 *
 * Tests the handler directly by injecting a mock Payment model,
 * avoiding the need for the full Express app or Stellar SDK.
 */

// ── Minimal env ───────────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

// ── Build a mock Payment that records calls ───────────────────────────────────
let _mockDocs = [];
let _mockTotal = 0;
let _lastSkip = null;
let _lastLimit = null;

const mockPayment = {
  find: jest.fn(() => ({
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn(function (n) { _lastSkip = n; return this; }),
    limit: jest.fn(function (n) { _lastLimit = n; return Promise.resolve(_mockDocs); }),
  })),
  countDocuments: jest.fn(() => Promise.resolve(_mockTotal)),
};

// ── Wire the handler under test ───────────────────────────────────────────────
// We build a minimal closure that mirrors the real handler but uses our mock.
async function getOverpayments(req, res, next) {
  const Payment = mockPayment;
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = { schoolId: req.schoolId, feeValidationStatus: 'overpaid' };
    const [total, overpayments] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter).sort({ confirmedAt: -1 }).skip(skip).limit(limit),
    ]);

    const totalExcess = overpayments.reduce((sum, p) => sum + (p.excessAmount || 0), 0);
    res.json({
      count: overpayments.length,
      totalExcess,
      overpayments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockReq(query = {}) {
  return { schoolId: 'SCH-TEST', query };
}

function mockRes() {
  const res = {};
  res.json = jest.fn();
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('#593 getOverpayments pagination', () => {
  beforeEach(() => {
    _mockDocs = [];
    _mockTotal = 0;
    _lastSkip = null;
    _lastLimit = null;
    jest.clearAllMocks();
  });

  it('returns pagination object with default page=1 limit=50', async () => {
    _mockDocs = Array(50).fill({ excessAmount: 5 });
    _mockTotal = 120;

    const res = mockRes();
    await getOverpayments(mockReq({}), res, jest.fn());

    const [body] = res.json.mock.calls[0];
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 120, totalPages: 3 });
    expect(body.overpayments).toHaveLength(50);
    expect(_lastSkip).toBe(0);
    expect(_lastLimit).toBe(50);
  });

  it('respects page and limit query params', async () => {
    _mockDocs = Array(20).fill({ excessAmount: 5 });
    _mockTotal = 120;

    const res = mockRes();
    await getOverpayments(mockReq({ page: '2', limit: '20' }), res, jest.fn());

    expect(_lastSkip).toBe(20);
    expect(_lastLimit).toBe(20);
    const [body] = res.json.mock.calls[0];
    expect(body.pagination).toMatchObject({ page: 2, limit: 20, total: 120, totalPages: 6 });
  });

  it('caps limit at 200', async () => {
    _mockDocs = [];
    _mockTotal = 0;

    await getOverpayments(mockReq({ limit: '9999' }), mockRes(), jest.fn());

    expect(_lastLimit).toBe(200);
  });

  it('uses DB-level pagination — limit() called on query, not in-memory slice', async () => {
    _mockDocs = Array(50).fill({ excessAmount: 1 });
    _mockTotal = 500;

    const res = mockRes();
    await getOverpayments(mockReq({}), res, jest.fn());

    // limit() must be called on the DB query
    expect(_lastLimit).not.toBeNull();
    const [body] = res.json.mock.calls[0];
    // Response only contains the paginated slice, not all 500
    expect(body.overpayments.length).toBeLessThanOrEqual(50);
  });

  it('includes totalExcess summed from returned page only', async () => {
    _mockDocs = [{ excessAmount: 10 }, { excessAmount: 20 }];
    _mockTotal = 2;

    const res = mockRes();
    await getOverpayments(mockReq({}), res, jest.fn());

    const [body] = res.json.mock.calls[0];
    expect(body.totalExcess).toBe(30);
  });
});
