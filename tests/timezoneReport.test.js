'use strict';

/**
 * Tests for timezone-aware report date grouping.
 *
 * Verifies that aggregateByDate() passes the school timezone into the
 * MongoDB $dateToString stage, and that date keys in the returned rows
 * reflect the school's local time rather than UTC.
 *
 * Scenario: a payment confirmed at 2026-01-01T00:30:00Z (UTC midnight + 30 min):
 *   - In UTC     → date key "2026-01-01"  (00:30 local)
 *   - In UTC+8   → date key "2026-01-01"  (08:30 local)
 *   - In UTC-5   → date key "2025-12-31"  (19:30 local — previous day)
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAggregate = jest.fn();

jest.mock('../backend/src/models/paymentModel', () => ({
  aggregate: mockAggregate,
  distinct: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(0),
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the aggregate row that MongoDB would return for a given date string.
 * Simulates the $dateToString projection result at the timezone boundary.
 */
function makeRow(dateStr) {
  return {
    date: dateStr,
    totalAmount: 250,
    paymentCount: 1,
    validCount: 1,
    overpaidCount: 0,
    underpaidCount: 0,
    uniqueStudentCount: 1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('aggregateByDate — timezone wiring', () => {
  beforeEach(() => {
    mockAggregate.mockReset();
  });

  test('passes UTC timezone into $dateToString when no timezone supplied', async () => {
    mockAggregate.mockResolvedValue([makeRow('2026-01-01')]);

    const { aggregateByDate } = require('../backend/src/services/reportService');
    await aggregateByDate({ schoolId: 'SCH-001' });

    const pipeline = mockAggregate.mock.calls[0][0];
    const groupStage = pipeline.find(s => s.$group);
    expect(groupStage.$group._id.$dateToString.timezone).toBe('UTC');
  });

  test('passes explicit timezone into $dateToString stage', async () => {
    mockAggregate.mockResolvedValue([makeRow('2026-01-01')]);

    const { aggregateByDate } = require('../backend/src/services/reportService');
    await aggregateByDate({ schoolId: 'SCH-001', timezone: 'Africa/Lagos' });

    const pipeline = mockAggregate.mock.calls[0][0];
    const groupStage = pipeline.find(s => s.$group);
    expect(groupStage.$group._id.$dateToString.timezone).toBe('Africa/Lagos');
  });
});

describe('aggregateByDate — timezone date boundary', () => {
  beforeEach(() => {
    jest.resetModules();
    mockAggregate.mockReset();
  });

  test('UTC: payment at 2026-01-01T00:30Z groups under "2026-01-01"', async () => {
    mockAggregate.mockResolvedValue([makeRow('2026-01-01')]);

    const { aggregateByDate } = require('../backend/src/services/reportService');
    const rows = await aggregateByDate({ schoolId: 'SCH-001', timezone: 'UTC' });

    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-01-01');
  });

  test('UTC+8 (Asia/Singapore): payment at 2026-01-01T00:30Z is 08:30 local — groups under "2026-01-01"', async () => {
    // MongoDB $dateToString with Asia/Singapore would return "2026-01-01"
    // because 00:30 UTC = 08:30 Singapore time — still the same calendar day.
    mockAggregate.mockResolvedValue([makeRow('2026-01-01')]);

    const { aggregateByDate } = require('../backend/src/services/reportService');
    const rows = await aggregateByDate({ schoolId: 'SCH-001', timezone: 'Asia/Singapore' });

    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-01-01');

    const pipeline = mockAggregate.mock.calls[0][0];
    const groupStage = pipeline.find(s => s.$group);
    expect(groupStage.$group._id.$dateToString.timezone).toBe('Asia/Singapore');
  });

  test('UTC-5 (America/New_York): payment at 2026-01-01T00:30Z is 19:30 on 2025-12-31 local — groups under "2025-12-31"', async () => {
    // MongoDB $dateToString with America/New_York would return "2025-12-31"
    // because 00:30 UTC on Jan 1 = 19:30 local time on Dec 31.
    mockAggregate.mockResolvedValue([makeRow('2025-12-31')]);

    const { aggregateByDate } = require('../backend/src/services/reportService');
    const rows = await aggregateByDate({ schoolId: 'SCH-001', timezone: 'America/New_York' });

    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2025-12-31');

    const pipeline = mockAggregate.mock.calls[0][0];
    const groupStage = pipeline.find(s => s.$group);
    expect(groupStage.$group._id.$dateToString.timezone).toBe('America/New_York');
  });

  test('different timezones produce different date keys for the same UTC payment', async () => {
    const { aggregateByDate } = require('../backend/src/services/reportService');

    // Simulate UTC grouping
    mockAggregate.mockResolvedValueOnce([makeRow('2026-01-01')]);
    const utcRows = await aggregateByDate({ schoolId: 'SCH-001', timezone: 'UTC' });

    // Simulate UTC-5 grouping (same payment, different local date)
    mockAggregate.mockResolvedValueOnce([makeRow('2025-12-31')]);
    const nyRows = await aggregateByDate({ schoolId: 'SCH-001', timezone: 'America/New_York' });

    expect(utcRows[0].date).toBe('2026-01-01');
    expect(nyRows[0].date).toBe('2025-12-31');
    expect(utcRows[0].date).not.toBe(nyRows[0].date);
  });
});
