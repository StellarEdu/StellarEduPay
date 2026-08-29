'use strict';

/**
 * Tests for issue #1373 — daily metrics TTL index.
 *
 * Daily rollups grow by one document per school per day forever, and only
 * today's is ever read. Monthly rollups must NOT expire: getDashboardMetrics
 * sums them for all-time totals, so dropping old months would silently shrink
 * historical figures. These tests pin that asymmetry, because adding a TTL to
 * monthly later would look like a harmless symmetry fix.
 */

// Every collection name the migration asks for, in order. Recorded by the mock
// factory itself so the assertion does not depend on which copy of mongoose the
// migration happened to resolve.
const collectionCalls = [];

// Top-level mongoose mock so migration tests don't hit a real connection.
const mockCollectionObj = {
  createIndex: jest.fn().mockResolvedValue({}),
  dropIndex:   jest.fn().mockResolvedValue({}),
  indexes:     jest.fn().mockResolvedValue([]),
};
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  actual.connection.collection = jest.fn((name) => {
    collectionCalls.push(name);
    return mockCollectionObj;
  });
  return actual;
});
// The migration and models under backend/ require the DUPLICATE
// backend/node_modules/mongoose copy, which the bare 'mongoose' mock above does
// not reach — mock it the same way so both copies share the mock collection.
jest.mock('../backend/node_modules/mongoose', () => {
  const actual = jest.requireActual('../backend/node_modules/mongoose');
  actual.connection.collection = jest.fn((name) => {
    collectionCalls.push(name);
    return mockCollectionObj;
  });
  return actual;
});

const DEFAULT_TTL_SECONDS = 400 * 24 * 60 * 60;

/** The TTL index entry on a schema, if any. */
function findTtlIndex(schema) {
  return schema
    .indexes()
    .find(([fields, opts]) => fields.createdAt !== undefined && opts.expireAfterSeconds !== undefined);
}

describe('metricsModel — TTL index on dailymetrics.createdAt', () => {
  const ORIGINAL_TTL = process.env.DAILY_METRICS_TTL_SECONDS;

  afterEach(() => {
    if (ORIGINAL_TTL === undefined) {
      delete process.env.DAILY_METRICS_TTL_SECONDS;
    } else {
      process.env.DAILY_METRICS_TTL_SECONDS = ORIGINAL_TTL;
    }
    jest.resetModules();
  });

  test('daily schema has a TTL index on createdAt with default 400 days', () => {
    delete process.env.DAILY_METRICS_TTL_SECONDS;
    const { DailyMetrics } = jest.requireActual('../backend/src/models/metricsModel');
    const ttlIndex = findTtlIndex(DailyMetrics.schema);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBe(DEFAULT_TTL_SECONDS);
  });

  test('TTL value is read from DAILY_METRICS_TTL_SECONDS env var', () => {
    process.env.DAILY_METRICS_TTL_SECONDS = '7776000';
    const { DailyMetrics } = jest.requireActual('../backend/src/models/metricsModel');
    const ttlIndex = findTtlIndex(DailyMetrics.schema);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBe(7776000);
  });

  test('the unique (schoolId, period) index is preserved', () => {
    const { DailyMetrics } = jest.requireActual('../backend/src/models/metricsModel');
    const unique = DailyMetrics.schema.indexes().filter(([, opts]) => opts && opts.unique);
    expect(unique).toHaveLength(1);
    expect(unique[0][0]).toEqual({ schoolId: 1, period: 1 });
  });

  test('monthly schema has NO TTL index — all-time totals are summed from it', () => {
    const { MonthlyMetrics } = jest.requireActual('../backend/src/models/metricsModel');
    expect(findTtlIndex(MonthlyMetrics.schema)).toBeUndefined();
  });

  test('monthly schema keeps its unique (schoolId, period) index', () => {
    const { MonthlyMetrics } = jest.requireActual('../backend/src/models/metricsModel');
    const unique = MonthlyMetrics.schema.indexes().filter(([, opts]) => opts && opts.unique);
    expect(unique).toHaveLength(1);
    expect(unique[0][0]).toEqual({ schoolId: 1, period: 1 });
  });
});

describe('migration 027 — TTL index on dailymetrics', () => {
  const migration = require('../backend/migrations/027_add_daily_metrics_ttl_index');

  beforeEach(() => {
    jest.clearAllMocks();
    mockCollectionObj.createIndex.mockResolvedValue({});
    mockCollectionObj.dropIndex.mockResolvedValue({});
    mockCollectionObj.indexes.mockResolvedValue([]);
    delete process.env.DAILY_METRICS_TTL_SECONDS;
  });

  test('up() creates the TTL index on dailymetrics', async () => {
    await migration.up();
    expect(mockCollectionObj.createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: DEFAULT_TTL_SECONDS }
    );
  });

  test('up() drops an existing TTL index before recreating it', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 60 },
    ]);
    await migration.up();
    expect(mockCollectionObj.dropIndex).toHaveBeenCalledWith('createdAt_1');
    expect(mockCollectionObj.createIndex).toHaveBeenCalled();
  });

  test('up() leaves a non-TTL index alone', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'schoolId_1_period_1', key: { schoolId: 1, period: 1 }, unique: true },
    ]);
    await migration.up();
    expect(mockCollectionObj.dropIndex).not.toHaveBeenCalled();
  });

  test('up() tolerates a collection that does not exist yet', async () => {
    const notFound = Object.assign(new Error('ns not found'), { code: 26 });
    mockCollectionObj.indexes.mockRejectedValue(notFound);
    await expect(migration.up()).resolves.toBeUndefined();
    expect(mockCollectionObj.createIndex).toHaveBeenCalled();
  });

  test('up() rethrows an unexpected indexes() error', async () => {
    mockCollectionObj.indexes.mockRejectedValue(Object.assign(new Error('boom'), { code: 13 }));
    await expect(migration.up()).rejects.toThrow('boom');
  });

  test('down() drops the TTL index', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: DEFAULT_TTL_SECONDS },
    ]);
    await migration.down();
    expect(mockCollectionObj.dropIndex).toHaveBeenCalledWith('createdAt_1');
  });

  test('it targets dailymetrics, never monthlymetrics', async () => {
    collectionCalls.length = 0;
    await migration.up();
    await migration.down();
    expect(collectionCalls.length).toBeGreaterThan(0);
    expect(new Set(collectionCalls)).toEqual(new Set(['dailymetrics']));
  });

  test('exposes the expected version', () => {
    expect(migration.version).toBe('027_add_daily_metrics_ttl_index');
  });
});
