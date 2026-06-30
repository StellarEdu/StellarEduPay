'use strict';

/**
 * Tests for cache key with data version and ReportJob model structure.
 * These are pure unit tests requiring no database connection.
 */

const { KEYS } = require('../backend/src/cache');

describe('Cache key with data version', () => {
  it('should include schoolId and dataVersion in cache key', () => {
    const key = KEYS.report('SCH-123', '2026-01-01', '2026-12-31', '2026-01-15T12:00:00.000Z');
    expect(key).toMatch(/^report:SCH-123:2026-01-01:2026-12-31:v/);
    expect(key).toContain('2026-01-15');
  });

  it('should return latest when no data version provided', () => {
    const key = KEYS.report('SCH-123', '2026-01-01', '2026-12-31');
    expect(key).toBe('report:SCH-123:2026-01-01:2026-12-31:vlatest');
  });

  it('should handle null date parameters', () => {
    const key = KEYS.report('SCH-123', null, null, '2026-01-15T12:00:00.000Z');
    expect(key).toBe('report:SCH-123:::v2026-01-15T12:00:00.000Z');
  });
});

describe('ReportJob model structure', () => {
  it('should have all required fields and statuses', () => {
    const { REPORT_STATUSES } = require('../backend/src/models/reportJobModel');
    expect(REPORT_STATUSES.PENDING).toBe('pending');
    expect(REPORT_STATUSES.PROCESSING).toBe('processing');
    expect(REPORT_STATUSES.COMPLETED).toBe('completed');
    expect(REPORT_STATUSES.FAILED).toBe('failed');
  });
});