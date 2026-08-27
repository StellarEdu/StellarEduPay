'use strict';

/**
 * Issue #1174 — Payment Plan Route & Controller Lifecycle Integration Test
 *
 * Verifies:
 *   1. POST /api/payment-plans/:studentId — Create a payment plan
 *   2. GET  /api/payment-plans/:studentId — Fetch the plan
 *   3. PATCH /api/payment-plans/:studentId/installment/:idx — Update an installment
 *   4. DELETE /api/payment-plans/:studentId — Cancel the plan
 *
 * Also verifies that the fixed require path in paymentPlanController.js does
 * not throw MODULE_NOT_FOUND (the original bug).
 */

// ── Environment stubs ─────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock models so no live DB is required
const mockPlanSave = jest.fn();
const mockPlanDoc = {
  schoolId: 'SCH-1174',
  studentId: 'STU001',
  totalAmount: 1000,
  status: 'active',
  installments: [
    { amount: 500, dueDate: new Date(), paid: false, paidAmount: 0 },
    { amount: 500, dueDate: new Date(), paid: false, paidAmount: 0 },
  ],
  save: mockPlanSave,
};
mockPlanSave.mockResolvedValue(mockPlanDoc);

jest.mock('../backend/src/models/paymentPlanModel', () => ({
  create: jest.fn().mockResolvedValue(mockPlanDoc),
  findOne: jest.fn().mockResolvedValue(mockPlanDoc),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue({
    schoolId: 'SCH-1174',
    studentId: 'STU001',
    name: 'Alice',
    feeAmount: 1000,
  }),
}));

// auditService mock — the fix ensures this resolves without MODULE_NOT_FOUND
jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

// ── Test setup ────────────────────────────────────────────────────────────────

const {
  createPaymentPlan,
  getPaymentPlan,
  updateInstallmentStatus,
  cancelPaymentPlan,
} = require('../backend/src/controllers/paymentPlanController');

/** Build a minimal Express req/res/next triple for unit-level controller tests */
function makeReq(overrides = {}) {
  return {
    schoolId:     'SCH-1174',
    params:       { studentId: 'STU001', installmentIndex: 0 },
    body:         {},
    auditContext: { performedBy: 'admin@test.com', ipAddress: '127.0.0.1', userAgent: 'jest' },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;  return this; },
  };
  return res;
}

const next = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockPlanSave.mockResolvedValue(mockPlanDoc);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#1174 — paymentPlanController require path fix', () => {
  test('controller module loads without MODULE_NOT_FOUND error', () => {
    // If the require path were wrong the import above would throw; this test
    // simply confirms the module resolved successfully.
    expect(typeof createPaymentPlan).toBe('function');
    expect(typeof getPaymentPlan).toBe('function');
    expect(typeof updateInstallmentStatus).toBe('function');
    expect(typeof cancelPaymentPlan).toBe('function');
  });
});

describe('#1174 — POST /api/payment-plans/:studentId (create)', () => {
  test('creates a payment plan and returns 201 with the plan document', async () => {
    const PaymentPlan = require('../backend/src/models/paymentPlanModel');
    const req = makeReq({
      body: {
        installments: [
          { amount: 500, dueDate: new Date(Date.now() + 30 * 86400000).toISOString() },
          { amount: 500, dueDate: new Date(Date.now() + 60 * 86400000).toISOString() },
        ],
      },
    });
    const res = makeRes();

    await createPaymentPlan(req, res, next);

    expect(res._status).toBe(201);
    expect(res._body).toMatchObject({ studentId: 'STU001', totalAmount: 1000 });
    expect(PaymentPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH-1174', studentId: 'STU001', totalAmount: 1000 }),
    );
  });

  test('returns 400 when no installments are provided', async () => {
    const req = makeReq({ body: { installments: [] } });
    const res = makeRes();

    await createPaymentPlan(req, res, next);

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 when the student does not exist', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null);

    const req = makeReq({
      body: {
        installments: [{ amount: 1000, dueDate: new Date().toISOString() }],
      },
    });
    const res = makeRes();

    await createPaymentPlan(req, res, next);

    expect(res._status).toBe(404);
    expect(res._body.code).toBe('NOT_FOUND');
  });

  test('logAudit is called after successful create', async () => {
    const { logAudit } = require('../backend/src/services/auditService');
    const req = makeReq({
      body: {
        installments: [{ amount: 1000, dueDate: new Date().toISOString() }],
      },
    });
    const res = makeRes();

    await createPaymentPlan(req, res, next);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment_plan_create', schoolId: 'SCH-1174' }),
    );
  });
});

describe('#1174 — GET /api/payment-plans/:studentId (fetch)', () => {
  test('returns the payment plan document', async () => {
    const req = makeReq();
    const res = makeRes();

    await getPaymentPlan(req, res, next);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ studentId: 'STU001' });
  });

  test('returns 404 when no plan exists', async () => {
    const PaymentPlan = require('../backend/src/models/paymentPlanModel');
    PaymentPlan.findOne.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await getPaymentPlan(req, res, next);

    expect(res._status).toBe(404);
    expect(res._body.code).toBe('NOT_FOUND');
  });
});

describe('#1174 — PATCH installment (update installment status)', () => {
  test('marks an installment as paid and calls save()', async () => {
    const req = makeReq({
      params: { studentId: 'STU001', installmentIndex: 0 },
      body:   { paid: true, paidAmount: 500 },
    });
    const res = makeRes();

    await updateInstallmentStatus(req, res, next);

    expect(mockPlanSave).toHaveBeenCalled();
    expect(res._body).toBeDefined();
  });

  test('returns 400 when installmentIndex is out of range', async () => {
    const req = makeReq({
      params: { studentId: 'STU001', installmentIndex: 99 },
      body:   { paid: true },
    });
    const res = makeRes();

    await updateInstallmentStatus(req, res, next);

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('VALIDATION_ERROR');
  });
});

describe('#1174 — DELETE /api/payment-plans/:studentId (cancel)', () => {
  test('sets plan status to cancelled and calls save()', async () => {
    const req = makeReq();
    const res = makeRes();

    await cancelPaymentPlan(req, res, next);

    expect(mockPlanSave).toHaveBeenCalled();
    expect(res._body).toEqual({ message: 'Payment plan cancelled' });
  });

  test('returns 404 when no plan is found', async () => {
    const PaymentPlan = require('../backend/src/models/paymentPlanModel');
    PaymentPlan.findOne.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await cancelPaymentPlan(req, res, next);

    expect(res._status).toBe(404);
    expect(res._body.code).toBe('NOT_FOUND');
  });
});
