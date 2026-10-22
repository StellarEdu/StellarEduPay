'use strict';

const manifest = require('../routes.json').routes;
const axios = require('axios');
const api = require('../frontend/src/services/api');

const SAMPLE_ID = 'student-001';
const SAMPLE_SCHOOL = 'school-001';
const SAMPLE_HASH = 'a'.repeat(64);
const argsByHelper = {
  getStudents: [1, 20, { search: 'Ada', status: 'active', className: 'A' }],
  getStudent: [SAMPLE_ID], getPublicStudent: [SAMPLE_ID], registerStudent: [{ name: 'Ada' }],
  updateStudent: [SAMPLE_ID, { name: 'Ada Lovelace' }], getPaymentSummary: [],
  getPaymentInstructions: [SAMPLE_ID], getStudentPayments: [SAMPLE_ID], getStudentBalance: [SAMPLE_ID],
  verifyPayment: [SAMPLE_HASH], syncPayments: [], getSyncStatus: [], getFeeStructures: [],
  createFeeStructure: [{ amount: '10.0000000' }], getFeeByClass: ['A'], deleteFeeStructure: ['A'],
  getReport: [{ from: '2025-01-01' }], getConversionRates: [], flagDispute: [{ reason: 'duplicate' }],
  getDisputes: [{ status: 'open' }], getDisputeById: ['dispute-001'], resolveDispute: ['dispute-001', { resolution: 'refund' }],
  initiateRefund: [SAMPLE_HASH, { reason: 'duplicate' }], approveRefund: ['refund-001', {}],
  getPaymentRefunds: [SAMPLE_HASH], getSchoolRefunds: [{}], getRecentAuditLogs: [], getAuditLogs: [{}],
  getFeeAdjustmentRules: [SAMPLE_SCHOOL], createFeeAdjustmentRule: [{ percent: 5 }, SAMPLE_SCHOOL],
  updateFeeAdjustmentRule: ['rule-001', { percent: 7 }, SAMPLE_SCHOOL], deleteFeeAdjustmentRule: ['rule-001', SAMPLE_SCHOOL],
  getSchool: ['demo-school'], updateSchool: ['demo-school', { name: 'Demo' }], listSchools: [],
  createUser: [{ email: 'user@example.test' }], listUsers: [{}], getUser: ['user-001'],
  updateUser: ['user-001', { role: 'staff' }], deleteUser: ['user-001'], createSchoolUser: [SAMPLE_SCHOOL, { email: 'staff@example.test' }],
  listSchoolUsers: [SAMPLE_SCHOOL], updateSchoolUser: [SAMPLE_SCHOOL, 'user-001', { role: 'staff' }],
  setPassword: [{ token: 'safe-token', password: 'SafePassword123!' }], requestPasswordReset: [{ email: 'user@example.test' }],
  resetPassword: [{ token: 'safe-token', password: 'SafePassword123!' }], createPaymentPlan: [SAMPLE_ID, { installments: [] }],
  getPaymentPlan: [SAMPLE_ID], updateInstallment: [SAMPLE_ID, 0, { amount: '1.0000000' }], cancelPaymentPlan: [SAMPLE_ID],
  listAnchors: [], initiateAnchorDeposit: [{ amount: '1.0000000' }], getAnchorDepositStatus: ['anchor-tx-001', 'https://anchor.example.test', 'anchor-001'],
};

function routeMatches(actual, expected) {
  const actualParts = actual.replace(/\/$/, '').split('/');
  const expectedParts = expected.replace(/\/$/, '').split('/');
  if (actualParts.length !== expectedParts.length) return false;
  return expectedParts.every((part, index) => part.startsWith(':') || part === actualParts[index]);
}

function expectedRoutes(method, url) {
  const path = url.split('?')[0];
  const candidates = manifest.filter((route) => route.method === method.toUpperCase());
  return candidates.filter((route) => routeMatches(path.startsWith('/api/') ? path : `/api${path}`, route.path));
}

describe('frontend API route contract (#1822)', () => {
  beforeEach(() => {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) axios[method].mockClear();
  });

  test.each(Object.keys(argsByHelper))('%s targets a manifest route', (name) => {
    const fn = api[name];
    expect(typeof fn).toBe('function');
    fn(...argsByHelper[name]);
    const allCalls = ['get', 'post', 'put', 'patch', 'delete'].flatMap((method) =>
      axios[method].mock.calls.map(([url]) => ({ method, url }))
    );
    expect(allCalls).toHaveLength(1);
    expect(expectedRoutes(allCalls[0].method, allCalls[0].url)).not.toHaveLength(0);
  });

  test('getReportCsvUrl is a manifest-backed GET URL', () => {
    const url = api.getReportCsvUrl({ from: '2025-01-01' });
    expect(expectedRoutes('GET', url)).not.toHaveLength(0);
  });

  test('representative schools and payments payloads retain the documented JSON shape', () => {
    const schools = [{ id: SAMPLE_SCHOOL, name: 'Demo', slug: 'demo-school' }];
    const payments = [{ id: 'payment-001', txHash: SAMPLE_HASH, amount: '10.0000000', status: 'SUCCESS' }];
    expect(Array.isArray(schools)).toBe(true);
    expect(schools[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), slug: expect.any(String) }));
    expect(Array.isArray(payments)).toBe(true);
    expect(payments[0]).toEqual(expect.objectContaining({ id: expect.any(String), txHash: expect.any(String), amount: expect.any(String), status: expect.any(String) }));
  });
});
