'use strict';

/**
 * #575 — GET /api/audit-logs pagination, filtering, and boundary cases.
 * Tests the auditService.getAuditLogs function directly with a mocked AuditLog model.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLogs = [
  { _id: 'id1', schoolId: 'SCH-1', action: 'student_create', result: 'success', createdAt: new Date('2026-01-01') },
  { _id: 'id2', schoolId: 'SCH-1', action: 'fee_create',     result: 'failure', createdAt: new Date('2026-01-02') },
  { _id: 'id3', schoolId: 'SCH-1', action: 'student_delete', result: 'success', createdAt: new Date('2026-01-03') },
];

let mockFind;
let mockCount;

jest.mock('../backend/src/models/auditLogModel', () => ({
  find: (...args) => mockFind(...args),
  countDocuments: (...args) => mockCount(...args),
}));

function makeChain(results) {
  const chain = {
    hint:  jest.fn().mockReturnThis(),
    sort:  jest.fn().mockReturnThis(),
    skip:  jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean:  jest.fn().mockResolvedValue(results),
  };
  return chain;
}

const { getAuditLogs } = require('../backend/src/services/auditService');

beforeEach(() => {
  mockFind  = jest.fn(() => makeChain(mockLogs));
  mockCount = jest.fn().mockResolvedValue(mockLogs.length);
});

// ── Pagination envelope ───────────────────────────────────────────────────────

describe('pagination envelope', () => {
  test('returns logs, total, page, limit, and pages', async () => {
    const result = await getAuditLogs({ schoolId: 'SCH-1', page: 1, limit: 2 });
    expect(result).toHaveProperty('logs');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('limit');
    expect(result).toHaveProperty('pages');
    expect(Array.isArray(result.logs)).toBe(true);
  });

  test('page defaults to 1 and limit defaults to 50', async () => {
    const result = await getAuditLogs({ schoolId: 'SCH-1' });
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
  });

  test('totalPages is ceil(total / limit)', async () => {
    mockCount.mockResolvedValue(125);
    const result = await getAuditLogs({ schoolId: 'SCH-1', page: 1, limit: 50 });
    expect(result.pages).toBe(3); // ceil(125/50) = 3
  });

  test('limit is capped at 200', async () => {
    const result = await getAuditLogs({ schoolId: 'SCH-1', page: 1, limit: 999 });
    expect(result.limit).toBe(200);
    const chain = mockFind.mock.results[0].value;
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  test('skip is (page - 1) * limit', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', page: 3, limit: 10 });
    const chain = mockFind.mock.results[0].value;
    expect(chain.skip).toHaveBeenCalledWith(20); // (3-1)*10
  });

  test('empty results return pages=1, not 0', async () => {
    mockFind  = jest.fn(() => makeChain([]));
    mockCount = jest.fn().mockResolvedValue(0);
    const result = await getAuditLogs({ schoolId: 'SCH-1' });
    expect(result.pages).toBe(1);
    expect(result.total).toBe(0);
    expect(result.logs).toHaveLength(0);
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('filtering', () => {
  test('filters by action', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', action: 'student_create' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'student_create' }),
    );
  });

  test('filters by targetType', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', targetType: 'payment' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'payment' }),
    );
  });

  test('filters by performedBy', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', performedBy: 'admin@school.edu' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ performedBy: 'admin@school.edu' }),
    );
  });

  test('filters by result (success)', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', result: 'success' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success' }),
    );
  });

  test('filters by result (failure)', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', result: 'failure' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'failure' }),
    );
  });

  test('filters by startDate', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', startDate: '2026-01-01' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: expect.objectContaining({ $gte: expect.any(Date) }),
      }),
    );
  });

  test('filters by endDate', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', endDate: '2026-12-31' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: expect.objectContaining({ $lte: expect.any(Date) }),
      }),
    );
  });

  test('filters by date range (both startDate and endDate)', async () => {
    await getAuditLogs({ schoolId: 'SCH-1', startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: expect.objectContaining({ $gte: expect.any(Date), $lte: expect.any(Date) }),
      }),
    );
  });

  test('always scopes query to schoolId', async () => {
    await getAuditLogs({ schoolId: 'SCH-99' });
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCH-99' }),
    );
  });

  test('omits optional filters when not provided', async () => {
    await getAuditLogs({ schoolId: 'SCH-1' });
    const query = mockFind.mock.calls[0][0];
    expect(query).not.toHaveProperty('action');
    expect(query).not.toHaveProperty('targetType');
    expect(query).not.toHaveProperty('performedBy');
    expect(query).not.toHaveProperty('result');
    expect(query).not.toHaveProperty('createdAt');
  });
});

// ── Boundary cases ────────────────────────────────────────────────────────────

describe('boundary cases', () => {
  test('page beyond last page returns empty logs with correct total', async () => {
    mockFind  = jest.fn(() => makeChain([]));
    mockCount = jest.fn().mockResolvedValue(5);
    const result = await getAuditLogs({ schoolId: 'SCH-1', page: 99, limit: 50 });
    expect(result.logs).toHaveLength(0);
    expect(result.total).toBe(5);
    expect(result.page).toBe(99);
  });

  test('sorting is always by createdAt descending', async () => {
    await getAuditLogs({ schoolId: 'SCH-1' });
    const chain = mockFind.mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
});
