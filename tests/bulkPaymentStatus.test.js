'use strict';

/**
 * Tests for issue #1372 — bulk payment status update.
 *
 * The endpoint is deliberately not all-or-nothing: a reconciliation batch
 * routinely contains payments that have already moved on, and failing the whole
 * request over them would leave the admin worse off than updating one at a
 * time. These tests pin the validation, that the audit trail is written per
 * payment, and that bulk can never perform a transition the single-payment
 * endpoint would reject.
 */

const fs = require('fs');
const path = require('path');

const CONTROLLER_PATH = path.join(
  __dirname,
  '..',
  'backend',
  'src',
  'controllers',
  'paymentAdminController.js'
);
const ROUTES_PATH = path.join(__dirname, '..', 'backend', 'src', 'routes', 'paymentRoutes.js');

describe('route registration', () => {
  const routes = fs.readFileSync(ROUTES_PATH, 'utf8');

  it('registers PATCH /bulk/status', () => {
    expect(routes).toContain('router.patch("/bulk/status"');
  });

  it('registers it BEFORE /:txHash/status, or "bulk" is read as a txHash', () => {
    const bulk = routes.indexOf('router.patch("/bulk/status"');
    const single = routes.indexOf('router.patch("/:txHash/status"');
    expect(bulk).toBeGreaterThan(-1);
    expect(single).toBeGreaterThan(-1);
    expect(bulk).toBeLessThan(single);
  });

  it('guards it with the same admin auth and audit context as the single route', () => {
    const line = routes.split('\n').find((l) => l.includes('router.patch("/bulk/status"'));
    expect(line).toContain('requireAdminAuth');
    expect(line).toContain('auditContext');
  });
});

describe('controller source contract', () => {
  const source = fs.readFileSync(CONTROLLER_PATH, 'utf8');

  it('routes both endpoints through one shared transition helper', () => {
    expect(source).toContain('async function applyStatusTransition(');
    // Call sites only — `await` excludes the function declaration itself.
    const calls = source.match(/await applyStatusTransition\(\{/g) || [];
    // One in the single endpoint, one in the bulk loop.
    expect(calls.length).toBe(2);
  });

  it('shares the status/reason validation between both endpoints', () => {
    expect(source).toContain('function validateStatusChange(');
    const calls = source.match(/validateStatusChange\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // definition + two call sites
  });

  it('scopes the lookup by schoolId so bulk cannot cross tenants', () => {
    expect(source).toContain('Payment.findOne({ schoolId: req.schoolId, txHash })');
  });

  it('writes an audit entry inside the shared helper, so bulk audits per payment', () => {
    const helperStart = source.indexOf('async function applyStatusTransition(');
    const helperEnd = source.indexOf('function validateStatusChange(');
    const helper = source.slice(helperStart, helperEnd);
    expect(helper).toContain('logAudit({');
    expect(helper).toContain("action: 'payment_status_update'");
  });

  it('caps the batch size from configuration', () => {
    expect(source).toContain('BULK_STATUS_UPDATE_LIMIT');
    expect(source).toContain('process.env.BULK_PAYMENT_STATUS_LIMIT');
  });
});

describe('bulkUpdatePaymentStatus', () => {
  let controller;

  beforeAll(() => {
    process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);
    controller = require('../backend/src/controllers/paymentAdminController');
  });

  /** Minimal res double capturing status and body. */
  function makeRes() {
    return {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  const baseReq = (body) => ({
    schoolId: 'SCH-1',
    body,
    auditContext: { performedBy: 'admin' },
  });

  async function callBulk(body) {
    const res = makeRes();
    await controller.bulkUpdatePaymentStatus(baseReq(body), res, jest.fn());
    return res;
  }

  it('rejects a missing txHashes array', async () => {
    const res = await callBulk({ status: 'SUCCESS', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty txHashes array', async () => {
    const res = await callBulk({ txHashes: [], status: 'SUCCESS', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a batch over the limit', async () => {
    const tooMany = Array.from(
      { length: controller.BULK_STATUS_UPDATE_LIMIT + 1 },
      (_, i) => `tx-${i}`
    );
    const res = await callBulk({ txHashes: tooMany, status: 'SUCCESS', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
    expect(res.body.limit).toBe(controller.BULK_STATUS_UPDATE_LIMIT);
  });

  it('rejects duplicate txHashes', async () => {
    const res = await callBulk({ txHashes: ['a', 'a'], status: 'SUCCESS', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-string entries', async () => {
    const res = await callBulk({ txHashes: ['a', 42], status: 'SUCCESS', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('requires a reason, exactly like the single endpoint', async () => {
    const res = await callBulk({ txHashes: ['a'], status: 'SUCCESS' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a transition to PENDING, exactly like the single endpoint', async () => {
    const res = await callBulk({ txHashes: ['a'], status: 'PENDING', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('validates the batch before touching the database', async () => {
    const Payment = require('../backend/src/models/paymentModel');
    const spy = jest.spyOn(Payment, 'findOne');
    await callBulk({ txHashes: [], status: 'SUCCESS', reason: 'r' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
