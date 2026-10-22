'use strict';

/**
 * Tests for issues #1184, #1185, #1186, #1187:
 * ?async=false must NOT enqueue a background job — the string "false" from
 * req.query is truthy in JavaScript, so it must be coerced to a boolean before
 * the `if (isAsync && isLargeReport)` check.
 *
 * Acceptance criteria: GET /api/reports?async=false over a large (≥30-day)
 * date range returns a synchronous response (200), NOT a 202 async job.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  KEYS: { report: jest.fn().mockReturnValue('report-key') },
  TTL: { REPORT: 60, REPORT_ASYNC: 3600 },
}));

const mockEnqueueReportJob = jest.fn();
jest.mock('../backend/src/queue/reportQueue', () => ({
  enqueueReportJob: mockEnqueueReportJob,
  getJobStatus: jest.fn(),
  setJobProcessing: jest.fn(),
  setJobCompleted: jest.fn(),
  setJobFailed: jest.fn(),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({ schoolId: 'school-1', timezone: 'UTC', isActive: true }),
  }),
}));

const mockGenerateReport = jest.fn().mockResolvedValue({ summary: {}, byDate: [] });
jest.mock('../backend/src/services/reportService', () => ({
  generateReport: mockGenerateReport,
  reportToCsv: jest.fn().mockReturnValue('col1,col2\nval1,val2'),
  getDashboardMetrics: jest.fn().mockResolvedValue({}),
  generateAccountingCsv: jest.fn().mockResolvedValue({ csv: 'csv-data', schemaVersion: 1 }),
  getDataVersion: jest.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
  ACCOUNTING_SCHEMA_VERSION: 1,
}));

jest.mock('../backend/src/models/reportJobModel', () => ({
  ReportJob: {
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  },
  REPORT_STATUSES: {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const { getReport } = require('../backend/src/controllers/reportController');

/** A large date range that exceeds the 30-day async threshold. */
const LARGE_START = '2026-01-01';
const LARGE_END   = '2026-03-31'; // 90 days

/** A small date range that stays under the threshold. */
const SMALL_START = '2026-06-01';
const SMALL_END   = '2026-06-10'; // 10 days

function makeReq(query = {}) {
  return { query, schoolId: 'school-1' };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)  { this._body = body; return this; },
    send(body)  { this._body = body; return this; },
    setHeader: jest.fn(),
  };
  return res;
}

async function callGetReport(query) {
  const req = makeReq(query);
  const res = makeRes();
  const errors = [];
  await getReport(req, res, (err) => { if (err) errors.push(err); });
  return { req, res, errors };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateReport.mockResolvedValue({ summary: {}, byDate: [] });
});

describe('issue #1184 — ?async=false string coercion (large date range)', () => {
  it('returns 200 and synchronous report when async=false, even for a large range', async () => {
    const { res, errors } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      async:     'false',
    });

    expect(errors).toHaveLength(0);
    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
  });

  it('does NOT return 202 when async=false for a large range', async () => {
    const { res } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      async:     'false',
    });

    expect(res._status).not.toBe(202);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
  });

  it('enqueues a job and returns 202 when async=true for a large range', async () => {
    mockEnqueueReportJob.mockResolvedValue({
      jobId: 'job-abc',
      reportJob: { statusUrl: '/api/reports/jobs/job-abc' },
    });

    const { res } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      async:     'true',
    });

    expect(mockEnqueueReportJob).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(202);
    expect(res._body).toMatchObject({ jobId: 'job-abc', status: 'pending' });
  });
});

describe('issue #1185 — ?async omitted entirely (large date range)', () => {
  it('returns synchronous report when async param is omitted for a large range', async () => {
    const { res, errors } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      // no async param — should default to synchronous
    });

    expect(errors).toHaveLength(0);
    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
  });
});

describe('issue #1186 — ?async=false for small date range', () => {
  it('returns synchronous report synchronously when async=false for a small range', async () => {
    const { res, errors } = await callGetReport({
      startDate: SMALL_START,
      endDate:   SMALL_END,
      async:     'false',
    });

    expect(errors).toHaveLength(0);
    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
  });

  it('returns synchronous report when async=true for a small range (not large enough to queue)', async () => {
    // Even with async=true, a small range doesn't cross the threshold so
    // the controller falls through to the synchronous path.
    const { res } = await callGetReport({
      startDate: SMALL_START,
      endDate:   SMALL_END,
      async:     'true',
    });

    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
  });
});

describe('issue #1187 — async param coercion edge cases', () => {
  it('treats the string "0" as falsy (not async)', async () => {
    const { res } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      async:     '0',
    });

    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
  });

  it('treats an empty string as falsy (not async)', async () => {
    const { res } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      async:     '',
    });

    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
  });

  it('treats "TRUE" (uppercase) as falsy — only exact "true" is accepted', async () => {
    // The fix uses strict === 'true', so "TRUE" must not trigger async.
    const { res } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      async:     'TRUE',
    });

    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
  });

  it('returns synchronous report for CSV format with async=false over large range', async () => {
    const { res } = await callGetReport({
      startDate: LARGE_START,
      endDate:   LARGE_END,
      format:    'csv',
      async:     'false',
    });

    expect(res._status).toBe(200);
    expect(mockEnqueueReportJob).not.toHaveBeenCalled();
    // Content-Disposition should be set for CSV download
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('attachment; filename=')
    );
  });
});
