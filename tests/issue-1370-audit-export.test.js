'use strict';

/**
 * #1370 — exportAuditLogsEndpoint controller unit tests
 *
 * Verifies CSV and JSON export behaviour via the controller with a mocked service.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/utils/logger', () => ({
  error: jest.fn(),
  warn:  jest.fn(),
  info:  jest.fn(),
  debug: jest.fn(),
  child: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

const mockExportFn = jest.fn();

jest.mock('../backend/src/services/auditService', () => ({
  exportAuditLogs: (...args) => mockExportFn(...args),
}));

// ── Subject ───────────────────────────────────────────────────────────────────

const { exportAuditLogsEndpoint } = require('../backend/src/controllers/auditController');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_LOGS = [
  {
    _id:          'aaa',
    schoolId:     'SCH-1',
    action:       'student_create',
    targetType:   'student',
    targetId:     'STU-1',
    performedBy:  'admin@school.edu',
    result:       'success',
    errorMessage: null,
    ipAddress:    '10.0.0.1',
    createdAt:    new Date('2026-01-01T08:00:00Z'),
  },
  {
    _id:          'bbb',
    schoolId:     'SCH-1',
    action:       'fee_create',
    targetType:   'fee',
    targetId:     'FEE-1',
    performedBy:  'admin@school.edu',
    result:       'failure',
    errorMessage: 'Duplicate fee, "Class A"',
    ipAddress:    '10.0.0.1',
    createdAt:    new Date('2026-01-02T09:00:00Z'),
  },
];

function makeRes() {
  return {
    setHeader: jest.fn(),
    json:      jest.fn().mockReturnThis(),
    send:      jest.fn().mockReturnThis(),
  };
}

function makeReq(query = {}) {
  return { schoolId: 'SCH-1', query };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExportFn.mockResolvedValue(MOCK_LOGS);
});

// ── CSV (default format) ──────────────────────────────────────────────────────

describe('exportAuditLogsEndpoint — CSV (default)', () => {
  test('sets Content-Type to text/csv', async () => {
    const req = makeReq({});
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
  });

  test('sets Content-Disposition attachment with .csv filename', async () => {
    const req = makeReq({});
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="audit-export.csv"',
    );
  });

  test('CSV first line is the header row', async () => {
    const req = makeReq({});
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    const csv = res.send.mock.calls[0][0];
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine).toBe(
      '_id,schoolId,action,targetType,targetId,performedBy,result,errorMessage,ipAddress,createdAt',
    );
  });

  test('CSV has one data row per log entry', async () => {
    const req = makeReq({});
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    const csv = res.send.mock.calls[0][0];
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 data rows
  });

  test('CSV escapes double-quotes and commas inside values', async () => {
    const req = makeReq({});
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    const csv = res.send.mock.calls[0][0];
    // errorMessage = 'Duplicate fee, "Class A"' — contains comma AND double-quotes
    expect(csv).toContain('"Duplicate fee, ""Class A"""');
  });

  test('empty result produces only the header line', async () => {
    mockExportFn.mockResolvedValue([]);
    const req = makeReq({});
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    const csv = res.send.mock.calls[0][0];
    expect(csv.split('\r\n')).toHaveLength(1);
  });
});

// ── JSON format ───────────────────────────────────────────────────────────────

describe('exportAuditLogsEndpoint — JSON format', () => {
  test('sets Content-Type to application/json', async () => {
    const req = makeReq({ format: 'json' });
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  test('sets Content-Disposition with .json filename', async () => {
    const req = makeReq({ format: 'json' });
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="audit-export.json"',
    );
  });

  test('calls res.json with the full logs array', async () => {
    const req = makeReq({ format: 'json' });
    const res = makeRes();
    await exportAuditLogsEndpoint(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(MOCK_LOGS);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('exportAuditLogsEndpoint — error handling', () => {
  test('forwards errors to next()', async () => {
    mockExportFn.mockRejectedValue(new Error('DB error'));
    const req = makeReq({});
    const res = makeRes();
    const next = jest.fn();
    await exportAuditLogsEndpoint(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
