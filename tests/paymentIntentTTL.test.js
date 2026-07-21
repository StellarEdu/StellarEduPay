'use strict';

/**
 * Tests for issue #403 — payment intent TTL index.
 */

// Top-level mongoose mock so migration tests don't hit a real connection.
const mockCollectionObj = {
  createIndex: jest.fn().mockResolvedValue({}),
  dropIndex:   jest.fn().mockResolvedValue({}),
  indexes:     jest.fn().mockResolvedValue([]),
};
// Delegate to the real mongoose (so schema tests that build `new mongoose.Schema`
// via jest.requireActual still work) but override connection.collection so the
// migration tests hit our mock collection instead of a real (absent) DB.
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  actual.connection.collection = jest.fn(() => mockCollectionObj);
  return actual;
});
// The migration and models under backend/ require the DUPLICATE
// backend/node_modules/mongoose copy, which the bare 'mongoose' mock above does
// not reach — mock it the same way so both copies share the mock collection.
jest.mock('../backend/node_modules/mongoose', () => {
  const actual = jest.requireActual('../backend/node_modules/mongoose');
  actual.connection.collection = jest.fn(() => mockCollectionObj);
  return actual;
});

describe('paymentIntentModel — TTL index on createdAt', () => {
  const ORIGINAL_TTL = process.env.PAYMENT_INTENT_TTL_SECONDS;

  afterEach(() => {
    // Restore env and clear module cache so the model is re-evaluated
    if (ORIGINAL_TTL === undefined) {
      delete process.env.PAYMENT_INTENT_TTL_SECONDS;
    } else {
      process.env.PAYMENT_INTENT_TTL_SECONDS = ORIGINAL_TTL;
    }
    jest.resetModules();
  });

  test('schema has a TTL index on createdAt with default 86400s', () => {
    delete process.env.PAYMENT_INTENT_TTL_SECONDS;
    const PaymentIntent = jest.requireActual('../backend/src/models/paymentIntentModel');
    const indexes = PaymentIntent.schema.indexes();
    const ttlIndex = indexes.find(([fields, opts]) =>
      fields.createdAt !== undefined && opts.expireAfterSeconds !== undefined
    );
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBe(86400);
  });

  test('TTL value is read from PAYMENT_INTENT_TTL_SECONDS env var', () => {
    process.env.PAYMENT_INTENT_TTL_SECONDS = '3600';
    const PaymentIntent = jest.requireActual('../backend/src/models/paymentIntentModel');
    const indexes = PaymentIntent.schema.indexes();
    const ttlIndex = indexes.find(([fields, opts]) =>
      fields.createdAt !== undefined && opts.expireAfterSeconds !== undefined
    );
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBe(3600);
  });
});

describe('migration 006 — TTL index on paymentintents', () => {
  const migration = require('../backend/migrations/006_add_payment_intent_ttl_index');

  beforeEach(() => {
    jest.clearAllMocks();
    mockCollectionObj.createIndex.mockResolvedValue({});
    mockCollectionObj.dropIndex.mockResolvedValue({});
    mockCollectionObj.indexes.mockResolvedValue([]);
    delete process.env.PAYMENT_INTENT_TTL_SECONDS;
  });

  test('up() creates TTL index on createdAt with default TTL', async () => {
    await migration.up();
    expect(mockCollectionObj.createIndex).toHaveBeenCalledWith({ createdAt: 1 }, { expireAfterSeconds: 86400 });
  });

  test('up() drops existing TTL index before creating new one', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 999 },
    ]);
    await migration.up();
    expect(mockCollectionObj.dropIndex).toHaveBeenCalledWith('createdAt_1');
    expect(mockCollectionObj.createIndex).toHaveBeenCalled();
  });

  test('down() drops the TTL index', async () => {
    mockCollectionObj.indexes.mockResolvedValue([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 86400 },
    ]);
    await migration.down();
    expect(mockCollectionObj.dropIndex).toHaveBeenCalledWith('createdAt_1');
  });

  test('up() respects PAYMENT_INTENT_TTL_SECONDS env var', async () => {
    // Reload the migration with the new env var value
    jest.resetModules();
    process.env.PAYMENT_INTENT_TTL_SECONDS = '7200';
    const freshMigration = require('../backend/migrations/006_add_payment_intent_ttl_index');
    await freshMigration.up();
    expect(mockCollectionObj.createIndex).toHaveBeenCalledWith({ createdAt: 1 }, { expireAfterSeconds: 7200 });
  });
});
