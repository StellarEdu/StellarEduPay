'use strict';

/**
 * Tests for issue #1414 — webhook delivery retention.
 *
 * The model already declared a TTL index, but Mongoose only creates schema
 * indexes on collections it creates, so any deployment whose collection
 * predates that declaration never got one and grew without bound. The
 * migration is the part that actually fixes those, which is why most of these
 * tests are about it rather than about the schema.
 */

// Top-level mongoose mock so migration tests don't hit a real connection.
const mockCollectionObj = {
  createIndex: jest.fn().mockResolvedValue({}),
  dropIndex:   jest.fn().mockResolvedValue({}),
  indexes:     jest.fn().mockResolvedValue([]),
};
const collectionCalls = [];
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  actual.connection.collection = jest.fn((name) => {
    collectionCalls.push(name);
    return mockCollectionObj;
  });
  return actual;
});
jest.mock('../backend/node_modules/mongoose', () => {
  const actual = jest.requireActual('../backend/node_modules/mongoose');
  actual.connection.collection = jest.fn((name) => {
    collectionCalls.push(name);
    return mockCollectionObj;
  });
  return actual;
});

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** The TTL index entry on a schema, if any. */
function findTtlIndex(schema) {
  return schema
    .indexes()
    .find(([fields, opts]) => fields.createdAt !== undefined && opts.expireAfterSeconds !== undefined);
}

describe('webhookDeliveryModel retention config', () => {
  const ORIGINAL = {
    days: process.env.WEBHOOK_DELIVERY_RETENTION_DAYS,
    seconds: process.env.WEBHOOK_DELIVERY_TTL_SECONDS,
  };

  afterEach(() => {
    for (const [key, value] of [
      ['WEBHOOK_DELIVERY_RETENTION_DAYS', ORIGINAL.days],
      ['WEBHOOK_DELIVERY_TTL_SECONDS', ORIGINAL.seconds],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
  });

  function loadModel() {
    return jest.requireActual('../backend/src/models/webhookDeliveryModel');
  }

  test('defaults to 90 days', () => {
    delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS;
    delete process.env.WEBHOOK_DELIVERY_TTL_SECONDS;
    expect(loadModel().resolveTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);
  });

  test('WEBHOOK_DELIVERY_RETENTION_DAYS sets the window', () => {
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '30';
    delete process.env.WEBHOOK_DELIVERY_TTL_SECONDS;
    expect(loadModel().resolveTtlSeconds()).toBe(30 * 24 * 60 * 60);
  });

  test('the legacy WEBHOOK_DELIVERY_TTL_SECONDS still wins when set', () => {
    process.env.WEBHOOK_DELIVERY_TTL_SECONDS = '123';
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '30';
    expect(loadModel().resolveTtlSeconds()).toBe(123);
  });

  test('a non-numeric retention falls back to the default', () => {
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = 'forever';
    delete process.env.WEBHOOK_DELIVERY_TTL_SECONDS;
    expect(loadModel().resolveTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);
  });

  test('a zero or negative retention falls back to the default', () => {
    delete process.env.WEBHOOK_DELIVERY_TTL_SECONDS;
    for (const value of ['0', '-5']) {
      process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = value;
      jest.resetModules();
      expect(loadModel().resolveTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);
    }
  });

  test('the schema declares the TTL index on createdAt', () => {
    delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS;
    delete process.env.WEBHOOK_DELIVERY_TTL_SECONDS;
    const ttlIndex = findTtlIndex(loadModel().schema);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBe(DEFAULT_TTL_SECONDS);
  });

  test('the existing query indexes are preserved', () => {
    const keys = loadModel()
      .schema.indexes()
      .map(([fields]) => Object.keys(fields).join(','));
    expect(keys).toEqual(expect.arrayContaining(['endpointId,createdAt', 'schoolId,createdAt']));
  });
});

describe('migration 028 — TTL index on webhookdeliveries', () => {
  const migration = require('../backend/migrations/028_add_webhook_delivery_ttl_index');

  beforeEach(() => {
    jest.clearAllMocks();
    collectionCalls.length = 0;
    mockCollectionObj.createIndex.mockResolvedValue({});
    mockCollectionObj.dropIndex.mockResolvedValue({});
    mockCollectionObj.indexes.mockResolvedValue([]);
  });

  test('up() creates the TTL index with the default retention', async () => {
    await migration.up();
    expect(mockCollectionObj.createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: DEFAULT_TTL_SECONDS },
    );
  });

  test('up() re-creates the index when retention changed', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 60 },
    ]);
    await migration.up();
    expect(mockCollectionObj.dropIndex).toHaveBeenCalledWith('createdAt_1');
    expect(mockCollectionObj.createIndex).toHaveBeenCalled();
  });

  test('up() leaves a non-TTL index on createdAt alone', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'schoolId_1_createdAt_-1', key: { schoolId: 1, createdAt: -1 } },
    ]);
    await migration.up();
    expect(mockCollectionObj.dropIndex).not.toHaveBeenCalled();
  });

  test('up() tolerates a collection that does not exist yet', async () => {
    mockCollectionObj.indexes.mockRejectedValue(
      Object.assign(new Error('ns not found'), { code: 26 }),
    );
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

  test('it only ever touches webhookdeliveries', async () => {
    await migration.up();
    await migration.down();
    expect(new Set(collectionCalls)).toEqual(new Set(['webhookdeliveries']));
  });

  test('exposes the expected version', () => {
    expect(migration.version).toBe('028_add_webhook_delivery_ttl_index');
  });
});

describe('documentation', () => {
  const fs = require('fs');
  const path = require('path');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'WEBHOOK_INTEGRATION.md'), 'utf8');

  test('documents the retention policy and both variables', () => {
    expect(doc).toContain('WEBHOOK_DELIVERY_RETENTION_DAYS');
    expect(doc).toContain('WEBHOOK_DELIVERY_TTL_SECONDS');
    expect(doc).toMatch(/90 days/);
  });

  test('names the migration operators must run', () => {
    expect(doc).toContain('028_add_webhook_delivery_ttl_index');
  });
});
