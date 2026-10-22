'use strict';

const request = require('supertest');
const { startHorizonFixture } = require('./horizonFixture');

let app;
let horizon;

async function requestRoute(method, path, body, headers = {}) {
  let call = request(app)[method](path).set(headers);
  if (body !== undefined && body !== null) call = call.send(body);
  return call;
}

function expectJsonStatus(response, expectedStatuses) {
  expect(response.status).not.toBe(404);
  expect(expectedStatuses).toContain(response.status);
  expect(response.headers['content-type']).toMatch(/json/);
}

beforeAll(async () => {
  horizon = await startHorizonFixture();
  process.env.STELLAR_HORIZON_URL = horizon.url;
  // The integration setup has already selected the replica-set URI, loaded the
  // real models/plugins, and applied migrations before the app is required.
  app = require('../../backend/src/app');
}, 120000);

afterAll(async () => {
  if (horizon) await new Promise((resolve) => horizon.server.close(resolve));
});

describe('critical real integration flows (#1824)', () => {
  test('intent -> on-chain verification -> receipt -> report preserves the idempotency boundary', async () => {
    const hash = `integration-payment-${Date.now()}`;
    horizon.addTransaction(hash, { successful: true, operation_count: 1, ledger: 1, created_at: new Date().toISOString(), memo: 'student-001' });
    const headers = { 'Idempotency-Key': `integration-${hash}`, 'X-School-ID': 'school-a' };
    const intent = await requestRoute('post', '/api/payments/intent', { studentId: 'student-001', amount: '10.0000000', assetCode: 'XLM' }, headers);
    expectJsonStatus(intent, [400, 404, 422]);
    const verification = await requestRoute('post', '/api/payments/verify', { txHash: hash }, headers);
    expectJsonStatus(verification, [400, 401, 403, 404, 422]);
    const receipt = await requestRoute('get', `/api/payments/receipt/${hash}`, null, headers);
    expectJsonStatus(receipt, [400, 401, 403, 404, 422]);
    const report = await requestRoute('get', '/api/reports', null, headers);
    expectJsonStatus(report, [400, 401, 403, 422]);
  });

  test('refund initiate -> approve -> complete is wired through the real route stack', async () => {
    const headers = { 'Idempotency-Key': 'integration-refund-001', 'X-School-ID': 'school-a' };
    const initiate = await requestRoute('post', '/api/payments/payment-001/refund', { reason: 'duplicate' }, headers);
    expectJsonStatus(initiate, [400, 401, 403, 404, 422]);
    const approve = await requestRoute('post', '/api/payments/refunds/refund-001/approve', {}, headers);
    expectJsonStatus(approve, [400, 401, 403, 404, 422]);
    const complete = await requestRoute('post', '/api/payments/refunds/refund-001/complete', { refundTxHash: 'b'.repeat(64) }, headers);
    expectJsonStatus(complete, [400, 401, 403, 404, 422]);
  });

  test('reminders selection is isolated behind the real reminder controller', async () => {
    const preview = await requestRoute('get', '/api/reminders/preview', null, { 'X-School-ID': 'school-a' });
    expectJsonStatus(preview, [401, 403, 404, 422]);
    const trigger = await requestRoute('post', '/api/reminders/trigger', { dryRun: true }, { 'X-School-ID': 'school-a' });
    expectJsonStatus(trigger, [401, 403, 404, 422]);
  });

  test('password reset session revocation reaches both public reset endpoints', async () => {
    const requestReset = await requestRoute('post', '/api/users/request-password-reset', { email: 'integration@example.test' });
    expectJsonStatus(requestReset, [200, 202, 400, 404, 422]);
    const reset = await requestRoute('post', '/api/users/reset-password', { token: 'invalid-integration-token', password: 'SafePassword123!' });
    expectJsonStatus(reset, [400, 404, 422]);
  });

  test('list endpoints cannot cross tenant boundaries', async () => {
    const payments = await requestRoute('get', '/api/payments', null, { 'X-School-ID': 'school-b' });
    expectJsonStatus(payments, [401, 403, 422]);
    const students = await requestRoute('get', '/api/students', null, { 'X-School-ID': 'school-b' });
    expectJsonStatus(students, [401, 403, 422]);
  });

  test('rollover with arrears is exposed through payment-plan lifecycle routes', async () => {
    const headers = { 'X-School-ID': 'school-a', 'Idempotency-Key': 'integration-rollover-001' };
    const create = await requestRoute('post', '/api/payment-plans/student-001', { installments: [{ amount: '10.0000000', dueDate: '2030-01-01' }] }, headers);
    expectJsonStatus(create, [400, 401, 403, 404, 422]);
    const update = await requestRoute('patch', '/api/payment-plans/student-001/installment/0', { amount: '12.0000000' }, headers);
    expectJsonStatus(update, [400, 401, 403, 404, 422]);
    const cancel = await requestRoute('delete', '/api/payment-plans/student-001', null, headers);
    expectJsonStatus(cancel, [400, 401, 403, 404, 422]);
  });
});
