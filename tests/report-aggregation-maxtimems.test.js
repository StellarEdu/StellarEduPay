'use strict';

/**
 * Tests: report aggregations carry a server-side time limit (#1376)
 *
 * socketTimeoutMS only abandons the client's socket — the server keeps
 * executing the pipeline and keeps holding its pool connection. maxTimeMS is
 * what actually makes the server stop, so every report aggregation must pass
 * one, or a slow report can pin a connection for the length of the query.
 *
 * Pure unit tests: the models are mocked, no database connection is required.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/models/studentModel');
jest.mock('../backend/src/models/feeStructureModel');

const Payment = require('../backend/src/models/paymentModel');
const Student = require('../backend/src/models/studentModel');
const { POOL_CONFIG } = require('../backend/src/config/database');
const reportService = require('../backend/src/services/reportService');

const EXPECTED_MAX_TIME_MS = POOL_CONFIG.reportAggregationMaxTimeMS;

beforeEach(() => {
  jest.clearAllMocks();
  Payment.aggregate = jest.fn().mockResolvedValue([]);
  Student.aggregate = jest.fn().mockResolvedValue([]);
});

describe('POOL_CONFIG.reportAggregationMaxTimeMS', () => {
  it('defaults to 15 seconds', () => {
    expect(EXPECTED_MAX_TIME_MS).toBe(15000);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(EXPECTED_MAX_TIME_MS)).toBe(true);
    expect(EXPECTED_MAX_TIME_MS).toBeGreaterThan(0);
  });

  it('is overridable through DB_REPORT_AGGREGATION_MAX_TIME_MS', () => {
    const previous = process.env.DB_REPORT_AGGREGATION_MAX_TIME_MS;
    process.env.DB_REPORT_AGGREGATION_MAX_TIME_MS = '3000';
    jest.resetModules();

    const reloaded = require('../backend/src/config/database').POOL_CONFIG;
    expect(reloaded.reportAggregationMaxTimeMS).toBe(3000);

    if (previous === undefined) {
      delete process.env.DB_REPORT_AGGREGATION_MAX_TIME_MS;
    } else {
      process.env.DB_REPORT_AGGREGATION_MAX_TIME_MS = previous;
    }
    jest.resetModules();
  });
});

describe('aggregateByDate', () => {
  it('passes maxTimeMS to the payment aggregation', async () => {
    await reportService.aggregateByDate({
      schoolId: 'SCH-123',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });

    expect(Payment.aggregate).toHaveBeenCalledTimes(1);
    const [, options] = Payment.aggregate.mock.calls[0];
    expect(options).toBeDefined();
    expect(options.maxTimeMS).toBe(EXPECTED_MAX_TIME_MS);
  });

  it('keeps the existing index hint alongside the time limit', async () => {
    await reportService.aggregateByDate({ schoolId: 'SCH-123' });

    const [, options] = Payment.aggregate.mock.calls[0];
    expect(options.hint).toEqual({ schoolId: 1, status: 1, confirmedAt: -1 });
    expect(options.maxTimeMS).toBe(EXPECTED_MAX_TIME_MS);
  });
});

describe('every aggregation in reportService', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'services', 'reportService.js'),
    'utf8'
  );

  it('has at least one aggregation to guard', () => {
    expect(source.match(/\.aggregate\(\[/g).length).toBeGreaterThan(0);
  });

  it('guards every aggregation call site', () => {
    const aggregations = source.match(/\.aggregate\(\[/g).length;
    const guarded = source.match(/reportAggregationMaxTimeMS/g).length;
    // One reference per call site; the require destructures POOL_CONFIG, so it
    // does not add an occurrence of the field name itself.
    expect(guarded).toBe(aggregations);
  });

  it('reads the limit from config rather than hard-coding a number', () => {
    expect(source).toContain("require('../config/database')");
    expect(source).not.toMatch(/maxTimeMS:\s*\d+/);
  });
});
