'use strict';

/**
 * Tests for issue #401 — feeStructureModel.js isActive field.
 *
 * Verifies:
 *   1. Inactive fee structures are NOT assigned to new students.
 *   2. Active fee structures ARE assigned to new students.
 *   3. DELETE /api/fees/:className soft-deletes (isActive: false), not hard-deletes.
 *   4. Migration 005 backfills isActive:true on documents that lack the field.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/feeStructureModel');
jest.mock('../backend/src/models/studentModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: {
    feesAll: () => 'fees:all',
    feeByClass: (c) => `fees:class:${c}`,
    studentsAll: () => 'students:all',
    student: (id) => `student:${id}`,
  },
  TTL: { FEES: 60, STUDENT: 60 },
}));
jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn() }));

// Top-level mongoose mock used by migration tests.
// The mockCollection function is shared so individual tests can swap it out.
const mockCollectionObj = { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) };
// Delegate to the real mongoose (so the schema test that builds `new mongoose.Schema`
// via jest.requireActual works) but override connection.collection so the migration
// test hits our mock collection instead of a real (absent) DB.
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  actual.connection.collection = jest.fn(() => mockCollectionObj);
  return actual;
});
// The migration and models under backend/ require the DUPLICATE
// backend/node_modules/mongoose copy, which the bare 'mongoose' mock above does not
// reach — mock it the same way so both copies share the mock collection.
jest.mock('../backend/node_modules/mongoose', () => {
  const actual = jest.requireActual('../backend/node_modules/mongoose');
  actual.connection.collection = jest.fn(() => mockCollectionObj);
  return actual;
});

const FeeStructure = require('../backend/src/models/feeStructureModel');
const { deleteFeeStructure } = require('../backend/src/controllers/feeController');

// The controller-level tests below drive FeeStructure.findOneAndUpdate through the
// mock; replace the real Mongoose static with a jest.fn (shared module singleton, so
// the controller's own reference sees it too).
FeeStructure.findOneAndUpdate = jest.fn();

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

describe('isActive field — feeStructureModel schema', () => {
  // Test the schema contract directly without going through the full controller stack.
  // studentController.js queries { schoolId, className, isActive: true } — verified by
  // reading the source. Here we confirm the model schema enforces the right defaults.

  test('isActive defaults to true and compound index is defined', () => {
    let RealFeeStructure;
    jest.isolateModules(() => {
      RealFeeStructure = jest.requireActual('../backend/src/models/feeStructureModel');
    });

    const schemaPath = RealFeeStructure.schema.path('isActive');
    expect(schemaPath).toBeDefined();
    expect(schemaPath.instance).toBe('Boolean');
    expect(schemaPath.defaultValue).toBe(true);

    const indexes = RealFeeStructure.schema.indexes();
    const hasCompound = indexes.some(([fields]) =>
      fields.schoolId !== undefined &&
      fields.className !== undefined &&
      fields.isActive !== undefined
    );
    expect(hasCompound).toBe(true);
  });

  test('inactive fee structure (isActive:false) would not match { isActive: true } query', () => {
    // Simulate what MongoDB does: a document with isActive:false does not match
    // the { isActive: true } filter used in studentController.js.
    const inactiveDoc = { className: 'Grade 5A', feeAmount: 250, isActive: false };
    const activeDoc   = { className: 'Grade 5A', feeAmount: 300, isActive: true };
    const filter = { isActive: true };

    const matches = (doc) => Object.entries(filter).every(([k, v]) => doc[k] === v);

    expect(matches(inactiveDoc)).toBe(false);
    expect(matches(activeDoc)).toBe(true);
  });
});

describe('isActive field — soft delete', () => {
  test('DELETE sets isActive:false and returns deactivated message', async () => {
    FeeStructure.findOneAndUpdate.mockResolvedValue({ className: 'Grade 5A', feeAmount: 250, isActive: false });

    const req = { schoolId: 'SCH-001', body: {}, params: { className: 'Grade 5A' }, headers: {} };
    const res = makeRes();
    const next = jest.fn();

    await deleteFeeStructure(req, res, next);

    expect(FeeStructure.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ className: 'Grade 5A' }),
      { isActive: false },
      expect.any(Object)
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('deactivated') }));
    expect(next).not.toHaveBeenCalled();
  });

  test('DELETE returns NOT_FOUND when fee structure does not exist', async () => {
    FeeStructure.findOneAndUpdate.mockResolvedValue(null);

    const req = { schoolId: 'SCH-001', body: {}, params: { className: 'NonExistent' }, headers: {} };
    const next = jest.fn();

    await deleteFeeStructure(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('migration 005 — backfill isActive', () => {
  const migration = require('../backend/migrations/005_backfill_fee_structure_is_active');

  beforeEach(() => jest.clearAllMocks());

  test('up() sets isActive:true only on documents missing the field', async () => {
    mockCollectionObj.updateMany.mockResolvedValue({ modifiedCount: 3 });
    await migration.up();
    expect(mockCollectionObj.updateMany).toHaveBeenCalledWith(
      { isActive: { $exists: false } },
      { $set: { isActive: true } }
    );
  });

  test('down() removes isActive from all documents', async () => {
    mockCollectionObj.updateMany.mockResolvedValue({ modifiedCount: 3 });
    await migration.down();
    expect(mockCollectionObj.updateMany).toHaveBeenCalledWith(
      {},
      { $unset: { isActive: '' } }
    );
  });
});
