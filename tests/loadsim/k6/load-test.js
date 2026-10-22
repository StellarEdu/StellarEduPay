import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL || '').replace(/\/$/, '');
const schoolIds = (__ENV.SCHOOL_IDS || __ENV.SCHOOL_ID || 'SCH0001').split(',').map(value => value.trim()).filter(Boolean);
const token = __ENV.AUTH_TOKEN || '';
const studentIds = (__ENV.STUDENT_IDS || 'STU000001').split(',').map(value => value.trim()).filter(Boolean);
const manifestPath = __ENV.LOAD_TEST_MANIFEST || '';
const manifest = manifestPath && __ENV.LOAD_TEST_START_TRAFFIC === 'true' ? JSON.parse(open(manifestPath)) : [];
const payments = manifest;
const expectedPayments = payments.length;
const readDuration = new Trend('api_read_duration', true);
const detectionLatency = new Trend('payment_detection_latency', true);
const recordedPayments = new Counter('payments_recorded');
const unmatchedPayments = new Counter('payments_unmatched');
const lostPayments = new Rate('lost_payments');
const apiReadSloMs = Number(__ENV.API_READ_SLO_MS || 300);
const detectionSloMs = Number(__ENV.DETECTION_SLO_MS || 30000);
const apiReadLimitMs = Number(__ENV.BASELINE_API_READ_P95_MS || 0) > 0
  ? Math.min(apiReadSloMs, Number(__ENV.BASELINE_API_READ_P95_MS) * 1.2)
  : apiReadSloMs;
const detectionLimitMs = Number(__ENV.BASELINE_DETECTION_P95_MS || 0) > 0
  ? Math.min(detectionSloMs, Number(__ENV.BASELINE_DETECTION_P95_MS) * 1.2)
  : detectionSloMs;

const headers = () => ({
  headers: {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-School-ID': schoolIds[__VU % schoolIds.length],
  },
  tags: { school: schoolIds[__VU % schoolIds.length] },
});
function request(method, path, body, params = headers()) {
  const started = Date.now();
  const response = http.request(method, `${baseUrl}${path}`, body, params);
  if (method === 'GET') readDuration.add(Date.now() - started);
  return response;
}
function studentIdFor(vu = __VU) { return studentIds[(vu - 1) % studentIds.length]; }
function verifyPayment() {
  if (!payments.length) return;
  const payment = payments[(__ITER * Math.max(1, __VU) - 1) % payments.length];
  const response = request('POST', '/api/payments/verify', JSON.stringify({ txHash: payment.txHash }), {
    ...headers(),
    headers: { ...headers().headers, 'Content-Type': 'application/json', 'Idempotency-Key': `load-${payment.txHash}` },
  });
  const recorded = check(response, { 'payment recorded': result => result.status >= 200 && result.status < 300 });
  if (recorded) {
    recordedPayments.add(1);
    const ledgerClosed = Date.parse(payment.ledgerClosedAt || payment.submittedAt);
    detectionLatency.add(Math.max(0, Date.now() - ledgerClosed));
    lostPayments.add(0);
  } else if (response.status >= 400 && response.status < 500) {
    unmatchedPayments.add(1);
    lostPayments.add(0);
  } else {
    lostPayments.add(1);
  }
}
function parentPayAndVerify() {
  const studentId = studentIdFor();
  const instructions = request('GET', `/api/payments/instructions/${studentId}`);
  check(instructions, { 'payment instructions available': result => result.status === 200 });
  verifyPayment();
}
function adminDashboardAndReports() {
  const dashboard = request('GET', '/api/reports/dashboard');
  const report = request('GET', '/api/reports?from=2020-01-01&to=2030-01-01');
  check(dashboard, { 'dashboard responds': result => result.status >= 200 && result.status < 500 });
  check(report, { 'report responds': result => result.status >= 200 && result.status < 500 });
}
function bulkImport() {
  const rows = ['studentId,name,class,feeAmount'];
  for (let index = 0; index < 25; index += 1) {
    rows.push(`LOAD-${__VU}-${__ITER}-${index},Load Import ${index},Grade 9,500`);
  }
  const response = request('POST', '/api/students/bulk', JSON.stringify({ csv: rows.join('\n') }), {
    ...headers(),
    headers: { ...headers().headers, 'Content-Type': 'application/json' },
  });
  check(response, { 'bulk import accepted': result => result.status >= 200 && result.status < 500 });
}
function reminderRun() {
  const preview = request('GET', '/api/reminders/preview');
  check(preview, { 'reminder preview responds': result => result.status >= 200 && result.status < 500 });
  if (__ENV.RUN_MUTATING_SCENARIOS === 'true') {
    const trigger = request('POST', '/api/reminders/trigger', JSON.stringify({}), {
      ...headers(),
      headers: { ...headers().headers, 'Content-Type': 'application/json' },
    });
    check(trigger, { 'reminder trigger responds': result => result.status >= 200 && result.status < 500 });
  }
}
function streamFanout() {
  const response = request('GET', `/api/payments/events?schoolId=${encodeURIComponent(schoolIds[__VU % schoolIds.length])}`);
  check(response, { 'SSE endpoint responds': result => result.status === 200 || result.status === 401 || result.status === 403 });
}
export const options = {
  scenarios: {
    parent_pay_verify: { executor: 'constant-arrival-rate', rate: Number(__ENV.PARENT_RATE || 10), timeUnit: '1s', duration: __ENV.PARENT_DURATION || '10m', preAllocatedVUs: 20, maxVUs: 200, exec: 'parentPayAndVerify' },
    admin_dashboard_reports: { executor: 'constant-vus', vus: Number(__ENV.ADMIN_VUS || 10), duration: __ENV.ADMIN_DURATION || '10m', exec: 'adminDashboardAndReports', startTime: '5s' },
    bulk_import: { executor: 'constant-arrival-rate', rate: Number(__ENV.BULK_RATE || 1), timeUnit: '1m', duration: __ENV.BULK_DURATION || '10m', preAllocatedVUs: 2, maxVUs: 10, exec: 'bulkImport', startTime: '10s' },
    reminder_runs: { executor: 'constant-vus', vus: Number(__ENV.REMINDER_VUS || 2), duration: __ENV.REMINDER_DURATION || '10m', exec: 'reminderRun', startTime: '15s' },
    sse_fanout: { executor: 'constant-vus', vus: Number(__ENV.SSE_VUS || 100), duration: __ENV.SSE_DURATION || '10m', exec: 'streamFanout', startTime: '20s' },
    soak_24h: { executor: 'constant-vus', vus: Number(__ENV.SOAK_VUS || 20), duration: __ENV.SOAK_DURATION || '24h', exec: 'adminDashboardAndReports', startTime: '30s' },
  },
  thresholds: {
    api_read_duration: [`p(95)<${apiReadLimitMs}`],
    payment_detection_latency: [`p(95)<${detectionLimitMs}`],
    http_req_failed: ['rate<0.01'],
    lost_payments: ['rate<0.001'],
  },
};
export function handleSummary(data) {
  const recorded = data.metrics.payments_recorded?.values.count || 0;
  const unmatched = data.metrics.payments_unmatched?.values.count || 0;
  const lost = Math.max(0, expectedPayments - recorded - unmatched);
  const summary = {
    generatedAt: new Date().toISOString(),
    expectedOnChainPayments: expectedPayments,
    recordedPayments: recorded,
    unmatchedPayments: unmatched,
    lostPayments: lost,
    metrics: data.metrics,
  };
  const output = __ENV.LOAD_TEST_SUMMARY || 'load-test-summary.json';
  return { [output]: JSON.stringify(summary, null, 2) };
}
export { parentPayAndVerify, adminDashboardAndReports, bulkImport, reminderRun, streamFanout };
