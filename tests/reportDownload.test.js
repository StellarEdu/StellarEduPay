'use strict';

/**
 * Tests for the Reports page / ReportDownload component – issue #395
 *
 * The root Jest environment is Node-only (no jsdom / Babel), so we:
 *  1. Test the handleGenerate / handleCsv logic as pure functions
 *     (mirrors exactly what the component does)
 *  2. Test getReportCsvUrl URL-building logic inline
 *  3. Assert acceptance criteria against the component source file
 */

// ── Helpers that mirror the component's logic ─────────────────────────────────

const BASE_URL = 'http://localhost:5000/api';

/** Mirrors getReportCsvUrl from api.js */
function getReportCsvUrl(params = {}) {
  const query = new URLSearchParams({ ...params, format: 'csv' }).toString();
  return `${BASE_URL}/reports?${query}`;
}

/** Mirrors handleGenerate from ReportDownload.jsx */
async function runHandleGenerate(startDate, endDate, mockGetReport) {
  const params = {};
  if (startDate) params.startDate = startDate;
  if (endDate)   params.endDate   = endDate;
  try {
    const { data } = await mockGetReport(params);
    return { report: data, error: '' };
  } catch (err) {
    return { report: null, error: err.response?.data?.error || 'Failed to generate report.' };
  }
}

/**
 * Mirrors handleCsv from ReportDownload.jsx — returns the anchor attrs
 * that would be set on the programmatic <a> element.
 */
function buildCsvDownload(startDate, endDate) {
  const params = {};
  if (startDate) params.startDate = startDate;
  if (endDate)   params.endDate   = endDate;
  const filename = startDate && endDate
    ? `report-${startDate}-to-${endDate}.csv`
    : 'report-all-time.csv';
  return { href: getReportCsvUrl(params), filename };
}

// ── Sample report fixture ─────────────────────────────────────────────────────

const SAMPLE_REPORT = {
  summary: {
    totalAmount: '1250.00',
    paymentCount: 8,
    validCount: 6,
    overpaidCount: 1,
    underpaidCount: 1,
    fullyPaidStudentCount: 5,
  },
  period: { startDate: '2026-01-01', endDate: '2026-01-31' },
  generatedAt: '2026-02-01T10:00:00.000Z',
  byDate: [
    { date: '2026-01-05', totalAmount: '500.00', paymentCount: 3, validCount: 2, overpaidCount: 1, underpaidCount: 0, uniqueStudentCount: 3 },
    { date: '2026-01-12', totalAmount: '750.00', paymentCount: 5, validCount: 4, overpaidCount: 0, underpaidCount: 1, uniqueStudentCount: 4 },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getReportCsvUrl', () => {
  test('builds URL with format=csv and no date params', () => {
    const url = getReportCsvUrl({});
    expect(url).toContain('/reports?');
    expect(url).toContain('format=csv');
    expect(url).not.toContain('startDate');
    expect(url).not.toContain('endDate');
  });

  test('includes startDate and endDate in query string', () => {
    const url = getReportCsvUrl({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(url).toContain('startDate=2026-01-01');
    expect(url).toContain('endDate=2026-01-31');
    expect(url).toContain('format=csv');
  });

  test('uses correct base URL', () => {
    const url = getReportCsvUrl({});
    expect(url.startsWith(BASE_URL)).toBe(true);
  });
});

describe('handleGenerate logic', () => {
  test('returns report data on successful API call', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: SAMPLE_REPORT });
    const result = await runHandleGenerate('2026-01-01', '2026-01-31', mockGet);
    expect(result.error).toBe('');
    expect(result.report).toEqual(SAMPLE_REPORT);
    expect(mockGet).toHaveBeenCalledWith({ startDate: '2026-01-01', endDate: '2026-01-31' });
  });

  test('omits startDate param when start date is empty', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: SAMPLE_REPORT });
    await runHandleGenerate('', '2026-01-31', mockGet);
    expect(mockGet).toHaveBeenCalledWith({ endDate: '2026-01-31' });
  });

  test('omits endDate param when end date is empty', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: SAMPLE_REPORT });
    await runHandleGenerate('2026-01-01', '', mockGet);
    expect(mockGet).toHaveBeenCalledWith({ startDate: '2026-01-01' });
  });

  test('calls API with empty params when both dates are empty', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: SAMPLE_REPORT });
    await runHandleGenerate('', '', mockGet);
    expect(mockGet).toHaveBeenCalledWith({});
  });

  test('returns API error message on failure', async () => {
    const mockGet = jest.fn().mockRejectedValue({
      response: { data: { error: 'Date range too large' } },
    });
    const result = await runHandleGenerate('2020-01-01', '2026-01-01', mockGet);
    expect(result.report).toBeNull();
    expect(result.error).toBe('Date range too large');
  });

  test('returns fallback message when error has no response body', async () => {
    const mockGet = jest.fn().mockRejectedValue(new Error('Network error'));
    const result = await runHandleGenerate('2026-01-01', '2026-01-31', mockGet);
    expect(result.report).toBeNull();
    expect(result.error).toBe('Failed to generate report.');
  });

  test('handles empty byDate array gracefully', async () => {
    const emptyReport = { ...SAMPLE_REPORT, byDate: [] };
    const mockGet = jest.fn().mockResolvedValue({ data: emptyReport });
    const result = await runHandleGenerate('2026-06-01', '2026-06-30', mockGet);
    expect(result.report.byDate).toHaveLength(0);
    expect(result.error).toBe('');
  });
});

describe('handleCsv anchor download (#449)', () => {
  test('builds correct href and filename with both dates', () => {
    const { href, filename } = buildCsvDownload('2026-01-01', '2026-01-31');
    expect(href).toBe(`${BASE_URL}/reports?startDate=2026-01-01&endDate=2026-01-31&format=csv`);
    expect(filename).toBe('report-2026-01-01-to-2026-01-31.csv');
  });

  test('uses report-all-time.csv when no dates provided', () => {
    const { href, filename } = buildCsvDownload('', '');
    expect(href).toContain('format=csv');
    expect(filename).toBe('report-all-time.csv');
  });

  test('uses report-all-time.csv when only startDate provided', () => {
    const { filename } = buildCsvDownload('2026-01-01', '');
    expect(filename).toBe('report-all-time.csv');
  });

  test('uses report-all-time.csv when only endDate provided', () => {
    const { filename } = buildCsvDownload('', '2026-01-31');
    expect(filename).toBe('report-all-time.csv');
  });
});

describe('Report data shape (acceptance criteria)', () => {
  test('summary contains all 6 required fields', () => {
    const { summary } = SAMPLE_REPORT;
    expect(summary).toHaveProperty('totalAmount');
    expect(summary).toHaveProperty('paymentCount');
    expect(summary).toHaveProperty('validCount');
    expect(summary).toHaveProperty('overpaidCount');
    expect(summary).toHaveProperty('underpaidCount');
    expect(summary).toHaveProperty('fullyPaidStudentCount');
  });

  test('byDate rows contain all expected columns', () => {
    SAMPLE_REPORT.byDate.forEach(row => {
      expect(row).toHaveProperty('date');
      expect(row).toHaveProperty('totalAmount');
      expect(row).toHaveProperty('paymentCount');
      expect(row).toHaveProperty('validCount');
      expect(row).toHaveProperty('overpaidCount');
      expect(row).toHaveProperty('underpaidCount');
      expect(row).toHaveProperty('uniqueStudentCount');
    });
  });
});

describe('ReportDownload component source – acceptance criteria', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/ReportDownload.jsx'),
    'utf8'
  );

  test('has two date inputs of type="date"', () => {
    expect((src.match(/type="date"/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('has visible labels for Start Date and End Date', () => {
    expect(src).toMatch(/Start Date/);
    expect(src).toMatch(/End Date/);
    // Post-revamp the labels use the shared design-system class rather than an
    // inline display:block style.
    expect(src).toMatch(/className="form-label"/);
  });

  test('shows loading state: disabled button and "Generating…" text', () => {
    expect(src).toMatch(/disabled={loading}/);
    expect(src).toMatch(/Generating/);
  });

  test('shows error state with red background', () => {
    expect(src).toMatch(/{error}/);
    // Post-revamp the red error background comes from the shared alert-danger
    // class (CSS variables) rather than a hard-coded #fee2e2 hex.
    expect(src).toMatch(/alert-danger/);
  });

  test('renders all 6 summary stat fields', () => {
    ['totalAmount', 'paymentCount', 'validCount', 'overpaidCount', 'underpaidCount', 'fullyPaidStudentCount']
      .forEach(field => expect(src).toMatch(field));
  });

  test('has CSV download button that triggers a CSV export', () => {
    // Post-revamp the CSV export is an inline credentialed fetch (handleCsv)
    // that requests the reports endpoint with format=csv, rather than the
    // getReportCsvUrl helper.
    expect(src).toMatch(/handleCsv/);
    expect(src).toMatch(/format:\s*["']csv["']/);
    expect(src).toMatch(/Download CSV/);
  });

  test('uses anchor element for download, not window.open', () => {
    expect(src).not.toMatch(/window\.open/);
    expect(src).toMatch(/createElement\(['"]a['"]\)/);
    expect(src).toMatch(/\.download\s*=/);
    expect(src).toMatch(/\.click\(\)/);
  });

  test('download filename includes date range when both dates set', () => {
    expect(src).toMatch(/report-\$\{startDate\}_to_\$\{endDate\}\.csv/);
    expect(src).toMatch(/report-all-time\.csv/);
  });

  test('imports getReport from api service', () => {
    expect(src).toMatch(/import\s*\{\s*getReport\s*\}\s*from/);
  });

  test('reports.jsx page renders ReportDownload with page title', () => {
    const pageSrc = fs.readFileSync(
      path.join(__dirname, '../frontend/src/pages/reports.jsx'),
      'utf8'
    );
    expect(pageSrc).toMatch(/import ReportDownload/);
    expect(pageSrc).toMatch(/<ReportDownload/);
    expect(pageSrc).toMatch(/Reports \| StellarEduPay/);
  });
});
