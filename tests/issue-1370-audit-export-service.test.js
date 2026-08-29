'use strict';

/**
 * #1370 — exportAuditLogs service unit tests
 *
 * Tests the service function directly with a mocked AuditLog model.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/utils/logger', () => ({
  error: jest.fn(),
  warn:  jest.fn(),
  info:  jest.fn(),
  debug: jest.fn(),
  child: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

let mockFind;

jest.mock('../backend/src/models/auditLogModel', () => ({
  find: (...args) => mockFind(...args),
  findOne: () => ({
    sort: () => ({ select: () => ({ lean: () => ({ bypassTenantScope: () => Promise.resolve(null) }) }) }),
  }),
}));

function makeFindChain(results) {
  return {
    sort:  jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean:  jest.fn().mockResolvedValue(results),
  };
}

// ── Sample data ───────────────────────────────────────────────────────────────

const MOCK_LOGS = [
  {
    _id: 'aaa', schoolId: 'SCH-1', action: 'student_create', targetType: 'student',
    targetId: 'STU-1', performedBy: 'admin@school.edu', result: 'success',
    errorMessage: null, ipAddress: '10.0.0.1', createdAt: new Date('2026-01-01T08:00:00Z'),
  },
  {
    _id: 'bbb', schoolId: 'SCH-1', action: 'fee_create', targetType: 'fee',
    targetId: 'FEE-1', performedBy: 'admin@school.edu', result: 'failure',
    errorMessage: 'Duplicate fee', ipAddress: '10.0.0.1', createdAt: new Date('2026-01-02T09:00:00Z'),
  },
];

// ── Subject ───────────────────────────────────────────────────────────────────

const { exportAuditLogs, MAX_EXPORT_ROWS } = require('../backend/src/services/auditService');

beforeEach(() => {
  jest.clearAllMocks();
  mockFind = jest.fn(() => makeFindChain(MOCK_LOGS));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('returns array of log objects', async () => {
  const logs = await exportAuditLogs({ schoolId: 'SCH-1' });
  expect(Array.isArray(logs)).toBe(true);
  expect(logs).toHaveLength(MOCK_LOGS.length);
});

test('scopes query to schoolId', async () => {
  await exportAuditLogs({ schoolId: 'SCH-99' });
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ schoolId: 'SCH-99' }));
});

test('sorts ascending by createdAt (oldest first)', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1' });
  const chain = mockFind.mock.results[0].value;
  expect(chain.sort).toHaveBeenCalledWith({ createdAt: 1 });
});

test('caps limit at MAX_EXPORT_ROWS', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1', limit: 9999999 });
  const chain = mockFind.mock.results[0].value;
  expect(chain.limit).toHaveBeenCalledWith(MAX_EXPORT_ROWS);
});

test('uses MAX_EXPORT_ROWS when limit is not specified', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1' });
  const chain = mockFind.mock.results[0].value;
  expect(chain.limit).toHaveBeenCalledWith(MAX_EXPORT_ROWS);
});

test('forwards action filter', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1', action: 'student_create' });
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ action: 'student_create' }));
});

test('forwards targetType filter', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1', targetType: 'payment' });
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'payment' }));
});

test('forwards performedBy filter', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1', performedBy: 'admin@x.edu' });
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ performedBy: 'admin@x.edu' }));
});

test('forwards result filter', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1', result: 'failure' });
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ result: 'failure' }));
});

test('forwards date range filters', async () => {
  await exportAuditLogs({ schoolId: 'SCH-1', startDate: '2026-01-01', endDate: '2026-12-31' });
  expect(mockFind).toHaveBeenCalledWith(
    expect.objectContaining({
      createdAt: expect.objectContaining({ $gte: expect.any(Date), $lte: expect.any(Date) }),
    }),
  );
});

test('MAX_EXPORT_ROWS is 10000', () => {
  expect(MAX_EXPORT_ROWS).toBe(10000);
});
