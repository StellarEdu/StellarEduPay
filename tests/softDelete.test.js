'use strict';

/**
 * Tests for softDelete.js utility (issue #390).
 *
 * Verifies that:
 *   1. The pre-hook correctly injects { deletedAt: null } into find queries.
 *   2. The pre-hook does NOT inject the filter when deletedAt is already set.
 *   3. The pre-hook does NOT inject the filter when .includeDeleted() is used.
 *   4. countDocuments is also filtered.
 *   5. findOneAndUpdate is also filtered.
 *
 * We test the middleware logic directly by constructing a minimal fake Mongoose
 * query context — no real database connection required.
 */

const softDelete = require('../backend/src/utils/softDelete');
const mongoose = require('mongoose');

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal schema, apply softDelete, then extract the registered
 * pre-hook for the given operation so we can call it in isolation.
 */
function getHook(operation) {
  const schema = new mongoose.Schema({ name: String });
  softDelete(schema);
  // Mongoose stores pre hooks in schema.s.hooks
  const hooks = schema.s.hooks._pres.get(operation) || [];
  // Return the first registered hook function
  return hooks[0]?.fn || hooks[0];
}

/**
 * Build a fake Mongoose query context that the hook receives as `this`.
 */
function makeQueryCtx({ existingQuery = {}, options = {} } = {}) {
  const query = { ...existingQuery };
  const opts  = { ...options };
  const conditions = {};

  return {
    getQuery:   () => query,
    getOptions: () => opts,
    // Simulate this.where({ deletedAt: null }) by merging into conditions
    where(cond) {
      Object.assign(conditions, cond);
      return this;
    },
    _conditions: conditions, // expose for assertions
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('softDelete utility — query filter (issue #390)', () => {

  describe('schema.add()', () => {
    it('adds a deletedAt field to the schema', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      expect(schema.path('deletedAt')).toBeDefined();
    });
  });

  describe('pre(find) hook', () => {
    it('injects { deletedAt: null } when deletedAt is not in the query', (done) => {
      const hook = getHook('find');
      const ctx  = makeQueryCtx({ existingQuery: {} });

      hook.call(ctx, () => {
        expect(ctx._conditions).toEqual({ deletedAt: null });
        done();
      });
    });

    it('does NOT inject filter when deletedAt is already in the query (explicit override)', (done) => {
      const hook = getHook('find');
      // Caller explicitly queries for deleted records
      const ctx  = makeQueryCtx({ existingQuery: { deletedAt: { $ne: null } } });

      hook.call(ctx, () => {
        // where() should not have been called — conditions stay empty
        expect(ctx._conditions).toEqual({});
        done();
      });
    });

    it('does NOT inject filter when deletedAt: null is already set (no double-filter)', (done) => {
      const hook = getHook('find');
      const ctx  = makeQueryCtx({ existingQuery: { deletedAt: null } });

      hook.call(ctx, () => {
        expect(ctx._conditions).toEqual({});
        done();
      });
    });

    it('does NOT inject filter when _includeDeleted option is set', (done) => {
      const hook = getHook('find');
      const ctx  = makeQueryCtx({ options: { _includeDeleted: true } });

      hook.call(ctx, () => {
        expect(ctx._conditions).toEqual({});
        done();
      });
    });
  });

  describe('pre(findOne) hook', () => {
    it('injects { deletedAt: null } for findOne', (done) => {
      const hook = getHook('findOne');
      const ctx  = makeQueryCtx({});

      hook.call(ctx, () => {
        expect(ctx._conditions).toEqual({ deletedAt: null });
        done();
      });
    });
  });

  describe('pre(countDocuments) hook', () => {
    it('injects { deletedAt: null } for countDocuments', (done) => {
      const hook = getHook('countDocuments');
      const ctx  = makeQueryCtx({});

      hook.call(ctx, () => {
        expect(ctx._conditions).toEqual({ deletedAt: null });
        done();
      });
    });
  });

  describe('pre(findOneAndUpdate) hook', () => {
    it('injects { deletedAt: null } for findOneAndUpdate', (done) => {
      const hook = getHook('findOneAndUpdate');
      const ctx  = makeQueryCtx({});

      hook.call(ctx, () => {
        expect(ctx._conditions).toEqual({ deletedAt: null });
        done();
      });
    });
  });

  describe('includeDeleted() query helper', () => {
    it('is registered on the schema', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      expect(typeof schema.query.includeDeleted).toBe('function');
    });

    it('sets _includeDeleted option so the hook skips filtering', (done) => {
      const hook = getHook('find');
      // Simulate what includeDeleted() does: sets _includeDeleted in options
      const ctx  = makeQueryCtx({ options: { _includeDeleted: true } });

      hook.call(ctx, () => {
        // No filter injected — deleted records are visible
        expect(ctx._conditions).toEqual({});
        done();
      });
    });
  });

  describe('instance and static methods', () => {
    it('adds softDelete and restore instance methods', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      expect(typeof schema.methods.softDelete).toBe('function');
      expect(typeof schema.methods.restore).toBe('function');
    });

    it('adds softDelete and restore static methods', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      expect(typeof schema.statics.softDelete).toBe('function');
      expect(typeof schema.statics.restore).toBe('function');
    });
  });

  describe('activeFilter() static method', () => {
    it('returns a filter with deletedAt: null when no filter is provided', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      const Model = mongoose.model('TestActiveFilter', schema);
      expect(Model.activeFilter()).toEqual({ deletedAt: null });
    });

    it('merges deletedAt: null into an existing filter', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      const Model = mongoose.model('TestActiveFilterMerge', schema);
      expect(Model.activeFilter({ schoolId: 'SCH001', status: 'SUCCESS' }))
        .toEqual({ schoolId: 'SCH001', status: 'SUCCESS', deletedAt: null });
    });

    it('overrides deletedAt if already present in the input filter', () => {
      const schema = new mongoose.Schema({ name: String });
      softDelete(schema);
      const Model = mongoose.model('TestActiveFilterOverride', schema);
      expect(Model.activeFilter({ deletedAt: { $ne: null } }))
        .toEqual({ deletedAt: null });
    });
  });
});
