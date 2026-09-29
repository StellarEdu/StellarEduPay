'use strict';

/**
 * Tests for Issue #1572 — Timezone-aware date range boundaries in reportService.
 *
 * The fix replaces the old pattern of appending 'T00:00:00.000Z' / 'T23:59:59.999Z'
 * (which forced UTC boundaries) with Intl-based helpers that resolve the correct
 * UTC instant for the start/end of a local calendar day in a given IANA timezone.
 *
 * Tests verify:
 *  - localDayStartUTC — correct UTC instant for UTC, positive, and negative offsets
 *  - localDayStartUTC — DST transition dates (clocks forward / back)
 *  - localDayEndUTC   — equals start of the NEXT calendar day (half-open interval)
 *  - buildDateRangeFilter — correct MongoDB $gte / $lt shape
 *  - buildDateRangeFilter — partial inputs (startDate only, endDate only, neither)
 *  - Old UTC-only pattern would produce wrong results for non-UTC schools
 */

// ── Mocks — reportService imports several heavy modules; stub them all ─────────

jest.mock('../src/models/paymentModel', () => ({
  aggregate:  jest.fn().mockResolvedValue([]),
  distinct:   jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/models/studentModel', () => ({
  find:       jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/models/feeStructureModel', () => ({
  find:       jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/config/database', () => ({
  POOL_CONFIG: {},
}));
jest.mock('../src/utils/csv', () => ({
  csvEscape: (v) => String(v ?? ''),
}));

// ── Subject under test ─────────────────────────────────────────────────────────

const {
  localDayStartUTC,
  localDayEndUTC,
  buildDateRangeFilter,
} = require('../src/services/reportService');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Format a Date as a UTC ISO string truncated to seconds for readable assertions.
 */
function utcSec(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── localDayStartUTC ──────────────────────────────────────────────────────────

describe('localDayStartUTC', () => {
  test('UTC timezone — midnight is exactly 00:00:00Z', () => {
    const result = localDayStartUTC('2024-06-15', 'UTC');
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  test('Pacific/Port_Moresby (+10:00, no DST) — local midnight is 14:00 the previous UTC day', () => {
    // Port Moresby is UTC+10 and has no DST.
    // Local midnight 2024-06-15 00:00 PGT = 2024-06-14 14:00:00 UTC
    const result = localDayStartUTC('2024-06-15', 'Pacific/Port_Moresby');
    expect(result.toISOString()).toBe('2024-06-14T14:00:00.000Z');
  });

  test('America/New_York (EST, -5:00) in winter — local midnight is 05:00 UTC same day', () => {
    // 2024-01-10 is in EST (UTC-5), so local midnight = 05:00 UTC
    const result = localDayStartUTC('2024-01-10', 'America/New_York');
    expect(result.toISOString()).toBe('2024-01-10T05:00:00.000Z');
  });

  test('America/New_York (EDT, -4:00) in summer — local midnight is 04:00 UTC same day', () => {
    // 2024-07-04 is in EDT (UTC-4), so local midnight = 04:00 UTC
    const result = localDayStartUTC('2024-07-04', 'America/New_York');
    expect(result.toISOString()).toBe('2024-07-04T04:00:00.000Z');
  });

  test('Europe/Berlin (CET, +1:00) in winter — local midnight is 23:00 the previous UTC day', () => {
    // 2024-01-15 00:00 CET = 2024-01-14 23:00:00 UTC
    const result = localDayStartUTC('2024-01-15', 'Europe/Berlin');
    expect(result.toISOString()).toBe('2024-01-14T23:00:00.000Z');
  });

  test('Europe/Berlin (CEST, +2:00) in summer — local midnight is 22:00 the previous UTC day', () => {
    // 2024-08-01 00:00 CEST = 2024-07-31 22:00:00 UTC
    const result = localDayStartUTC('2024-08-01', 'Europe/Berlin');
    expect(result.toISOString()).toBe('2024-07-31T22:00:00.000Z');
  });

  test('Asia/Kolkata (+5:30) — fractional offset is handled correctly', () => {
    // 2024-03-20 00:00 IST = 2024-03-19 18:30:00 UTC
    const result = localDayStartUTC('2024-03-20', 'Asia/Kolkata');
    expect(result.toISOString()).toBe('2024-03-19T18:30:00.000Z');
  });

  test('DST spring-forward (America/New_York, 2024-03-10) — clocks skip 02:00→03:00', () => {
    // On the spring-forward day, local midnight is still at 05:00 UTC (before the gap)
    const result = localDayStartUTC('2024-03-10', 'America/New_York');
    expect(result.toISOString()).toBe('2024-03-10T05:00:00.000Z');
  });

  test('DST fall-back (America/New_York, 2024-11-03) — clocks repeat 01:00→01:00', () => {
    // On the fall-back day, local midnight is at 04:00 UTC (before clock change)
    const result = localDayStartUTC('2024-11-03', 'America/New_York');
    expect(result.toISOString()).toBe('2024-11-03T04:00:00.000Z');
  });

  test('returns a Date object (not a number or string)', () => {
    const result = localDayStartUTC('2024-06-15', 'UTC');
    expect(result).toBeInstanceOf(Date);
  });

  test('handles year/month boundary (Dec 31 → Jan 1)', () => {
    // UTC+10: 2024-01-01 00:00 PGT = 2023-12-31 14:00 UTC
    const result = localDayStartUTC('2024-01-01', 'Pacific/Port_Moresby');
    expect(result.toISOString()).toBe('2023-12-31T14:00:00.000Z');
  });
});

// ── localDayEndUTC ────────────────────────────────────────────────────────────

describe('localDayEndUTC', () => {
  test('UTC — end of 2024-06-15 = start of 2024-06-16 = 2024-06-16T00:00:00.000Z', () => {
    const result = localDayEndUTC('2024-06-15', 'UTC');
    expect(result.toISOString()).toBe('2024-06-16T00:00:00.000Z');
  });

  test('Pacific/Port_Moresby (+10) — end of 2024-06-15 local = 2024-06-15T14:00:00.000Z UTC', () => {
    // Start of 2024-06-16 PGT = 2024-06-15 14:00 UTC
    const result = localDayEndUTC('2024-06-15', 'Pacific/Port_Moresby');
    expect(result.toISOString()).toBe('2024-06-15T14:00:00.000Z');
  });

  test('America/New_York (EDT) — end of 2024-07-04 local = 2024-07-05T04:00:00.000Z UTC', () => {
    // Start of 2024-07-05 EDT = 2024-07-05 04:00 UTC
    const result = localDayEndUTC('2024-07-04', 'America/New_York');
    expect(result.toISOString()).toBe('2024-07-05T04:00:00.000Z');
  });

  test('end > start for the same date in all tested timezones', () => {
    const zones = ['UTC', 'Pacific/Port_Moresby', 'America/New_York', 'Europe/Berlin', 'Asia/Kolkata'];
    const date = '2024-09-15';
    for (const tz of zones) {
      const start = localDayStartUTC(date, tz);
      const end   = localDayEndUTC(date, tz);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    }
  });

  test('end - start = exactly 24 h for a timezone with no DST (Pacific/Port_Moresby)', () => {
    const date = '2024-06-15';
    const start = localDayStartUTC(date, 'Pacific/Port_Moresby');
    const end   = localDayEndUTC(date, 'Pacific/Port_Moresby');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test('end - start = 23 h on spring-forward day (America/New_York, 2024-03-10)', () => {
    // Clocks spring forward, so 2024-03-10 is only 23 hours long in NY
    const start = localDayStartUTC('2024-03-10', 'America/New_York');
    const end   = localDayEndUTC('2024-03-10', 'America/New_York');
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  test('end - start = 25 h on fall-back day (America/New_York, 2024-11-03)', () => {
    // Clocks fall back, so 2024-11-03 is 25 hours long in NY
    const start = localDayStartUTC('2024-11-03', 'America/New_York');
    const end   = localDayEndUTC('2024-11-03', 'America/New_York');
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});

// ── buildDateRangeFilter ──────────────────────────────────────────────────────

describe('buildDateRangeFilter', () => {
  test('both startDate and endDate — returns { $gte, $lt }', () => {
    const filter = buildDateRangeFilter({
      startDate: '2024-06-01',
      endDate:   '2024-06-30',
      timezone:  'UTC',
    });
    expect(filter).toHaveProperty('$gte');
    expect(filter).toHaveProperty('$lt');
    expect(filter.$gte).toBeInstanceOf(Date);
    expect(filter.$lt).toBeInstanceOf(Date);
    expect(filter.$gte.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(filter.$lt.toISOString()).toBe('2024-07-01T00:00:00.000Z');
  });

  test('startDate only — returns { $gte } without $lt', () => {
    const filter = buildDateRangeFilter({ startDate: '2024-06-01', timezone: 'UTC' });
    expect(filter).toHaveProperty('$gte');
    expect(filter).not.toHaveProperty('$lt');
  });

  test('endDate only — returns { $lt } without $gte', () => {
    const filter = buildDateRangeFilter({ endDate: '2024-06-30', timezone: 'UTC' });
    expect(filter).toHaveProperty('$lt');
    expect(filter).not.toHaveProperty('$gte');
  });

  test('neither date — returns empty object {}', () => {
    const filter = buildDateRangeFilter({ timezone: 'UTC' });
    expect(filter).toEqual({});
  });

  test('defaults timezone to UTC when not provided', () => {
    const filter = buildDateRangeFilter({ startDate: '2024-06-01', endDate: '2024-06-30' });
    expect(filter.$gte.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(filter.$lt.toISOString()).toBe('2024-07-01T00:00:00.000Z');
  });

  test('uses timezone-aware boundaries for Pacific/Port_Moresby (+10)', () => {
    const filter = buildDateRangeFilter({
      startDate: '2024-06-01',
      endDate:   '2024-06-30',
      timezone:  'Pacific/Port_Moresby',
    });
    // Start of 2024-06-01 in PGT (UTC+10) = 2024-05-31T14:00:00Z
    expect(filter.$gte.toISOString()).toBe('2024-05-31T14:00:00.000Z');
    // Start of 2024-07-01 in PGT (UTC+10) = 2024-06-30T14:00:00Z
    expect(filter.$lt.toISOString()).toBe('2024-06-30T14:00:00.000Z');
  });

  test('$lt is strictly greater than $gte for same-day range', () => {
    const filter = buildDateRangeFilter({
      startDate: '2024-08-15',
      endDate:   '2024-08-15',
      timezone:  'America/New_York',
    });
    expect(filter.$lt.getTime()).toBeGreaterThan(filter.$gte.getTime());
  });
});

// ── Regression: old UTC-only pattern produces wrong results ───────────────────

describe('regression — old UTC-only pattern', () => {
  test('old pattern shifts boundaries incorrectly for UTC+10 schools', () => {
    // Old code: new Date('2024-06-01T00:00:00.000Z')
    // New code: localDayStartUTC('2024-06-01', 'Pacific/Port_Moresby')
    //
    // For a school in UTC+10, a payment confirmed at 2024-05-31T23:00:00Z is
    // locally on 2024-06-01 (09:00 PGT) — it SHOULD be included in a June report.
    // The old UTC pattern would EXCLUDE it because 23:00Z < midnight UTC.
    const oldStart = new Date('2024-06-01T00:00:00.000Z');
    const newStart = localDayStartUTC('2024-06-01', 'Pacific/Port_Moresby');

    // A payment at 2024-05-31T23:00:00Z is local 2024-06-01 09:00 PGT
    const paymentAt = new Date('2024-05-31T23:00:00.000Z');

    // Old pattern would exclude this payment (paymentAt < oldStart is false,
    // but paymentAt < newStart — the new start is earlier)
    expect(paymentAt.getTime()).toBeGreaterThanOrEqual(newStart.getTime()); // correctly included
    expect(paymentAt.getTime()).toBeLessThan(oldStart.getTime());           // old pattern missed it
  });

  test('old pattern shifts boundaries incorrectly for UTC-5 schools', () => {
    // For a school in New York (EDT, UTC-4 in summer), a payment at 2024-07-01T03:00:00Z
    // is locally still on 2024-06-30 (23:00 EDT) — it SHOULD NOT be in a July report.
    // The old UTC pattern would INCLUDE it because 03:00Z >= midnight UTC July 1.
    // localDayStartUTC('2024-07-01', 'America/New_York') = 2024-07-01T04:00:00Z (EDT = UTC-4)
    const oldStart = new Date('2024-07-01T00:00:00.000Z');
    const newStart = localDayStartUTC('2024-07-01', 'America/New_York'); // 2024-07-01T04:00:00Z

    const paymentAt = new Date('2024-07-01T03:00:00.000Z'); // locally still June 30 in EDT

    expect(paymentAt.getTime()).toBeGreaterThanOrEqual(oldStart.getTime()); // old pattern wrongly includes
    expect(paymentAt.getTime()).toBeLessThan(newStart.getTime());           // correctly excluded
  });
});
