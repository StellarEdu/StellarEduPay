'use strict';

/**
 * Tests for GET /api/reports date-range validation (issue #389).
 *
 * Exercises the validation logic in reportController.getReport directly
 * by constructing minimal req/res/next stubs — no Express or MongoDB needed.
 */

// Mock cache so the controller never tries to hit a real store
jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  KEYS: { report: jest.fn().mockReturnValue('report-key') },
  TTL: { REPORT: 60, REPORT_ASYNC: 3600 },
}));

// Mock report queue for async job handling
jest.mock('../backend/src/queue/reportQueue', () => ({
  enqueueReportJob: jest.fn(),
  getJobStatus: jest.fn(),
  setJobProcessing: jest.fn(),
  setJobCompleted: jest.fn(),
  setJobFailed: jest.fn(),
}));

// Mock report cache invalidator
jest.mock('../backend/src/services/reportCacheInvalidator', () => ({
  invalidate: jest.fn(),
}));

// Mock School model so the controller doesn't need a real DB
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue({ schoolId: 'school-1', timezone: 'UTC', isActive: true }),
  }),
}));

// Mock reportService so valid requests don't need a real DB
jest.mock('../backend/src/services/reportService', () => ({
  generateReport: jest.fn().mockResolvedValue({ summary: {}, byDate: [] }),
  reportToCsv: jest.fn().mockReturnValue('csv'),
  getDashboardMetrics: jest.fn().mockResolvedValue({}),
  getDataVersion: jest.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
  ACCOUNTING_SCHEMA_VERSION: 1,
}));

// Mock ReportJob model
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

const { getReport } = require('../backend/src/controllers/reportController');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReq(query = {}) {
  return { query, schoolId: 'school-1' };
}

function makeRes() {
  const res = { json: jest.fn(), send: jest.fn(), setHeader: jest.fn() };
  return res;
}

/** Calls getReport and returns the error passed to next(), or null on success. */
async function callGetReport(query) {
  const req = makeReq(query);
  const res = makeRes();
  let capturedErr = null;
  const next = (err) => { capturedErr = err || null; };
  await getReport(req, res, next);
  return capturedErr;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/reports — date validation (#389)', () => {
  // Note: Date format validation is handled by Joi middleware in reportSchemas.js
  // These tests verify the controller handles valid date inputs correctly
  describe('valid inputs', () => {
    it('accepts a valid date-only range (YYYY-MM-DD)', async () => {
      const err = await callGetReport({ startDate: '2026-01-01', endDate: '2026-12-31' });
      expect(err).toBeNull();
    });

    it('accepts a valid datetime range (ISO 8601 with time)', async () => {
      const err = await callGetReport({
        startDate: '2026-01-01T00:00:00Z',
        endDate:   '2026-12-31T23:59:59Z',
      });
      expect(err).toBeNull();
    });

    it('accepts startDate equal to endDate', async () => {
      const err = await callGetReport({ startDate: '2026-06-15', endDate: '2026-06-15' });
      expect(err).toBeNull();
    });

    it('accepts request with no date params', async () => {
      const err = await callGetReport({});
      expect(err).toBeNull();
    });

    it('accepts only startDate with no endDate', async () => {
      const err = await callGetReport({ startDate: '2026-01-01' });
      expect(err).toBeNull();
    });
  });

  // Date format validation via Joi middleware is tested in integration tests
  // Controller assumes validated input from middleware
})

describe('GET /api/reports — Content-Disposition filename (#469)', () => {
  async function getCsvHeaders(query) {
    const req = makeReq(query);
    const res = makeRes();
    await getReport(req, res, () => {});
    // Collect all setHeader calls into a map
    const headers = {};
    res.setHeader.mock.calls.forEach(([k, v]) => { headers[k] = v; });
    return headers;
  }

  it('sets filename with date range when both dates provided', async () => {
    const headers = await getCsvHeaders({ startDate: '2026-01-01', endDate: '2026-03-31', format: 'csv' });
    expect(headers['Content-Disposition']).toBe('attachment; filename="report-2026-01-01-to-2026-03-31.csv"');
  });

  it('sets report-all-time.csv when no dates provided', async () => {
    const headers = await getCsvHeaders({ format: 'csv' });
    expect(headers['Content-Disposition']).toBe('attachment; filename="report-all-time.csv"');
  });

  it('sets partial filename when only startDate provided', async () => {
    const headers = await getCsvHeaders({ startDate: '2026-01-01', format: 'csv' });
    expect(headers['Content-Disposition']).toBe('attachment; filename="report-2026-01-01-to-all-time.csv"');
  });

  it('sets partial filename when only endDate provided', async () => {
    const headers = await getCsvHeaders({ endDate: '2026-03-31', format: 'csv' });
    expect(headers['Content-Disposition']).toBe('attachment; filename="report-all-time-to-2026-03-31.csv"');
  });
});
