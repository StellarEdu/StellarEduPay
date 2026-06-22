'use strict';

/**
 * Tests for the tenantScope Mongoose plugin.
 *
 * Tests the plugin's hook logic directly without requiring a real MongoDB
 * connection, by calling the registered pre-hook functions with mock
 * Query and Aggregate objects — matching the shape Mongoose passes to them.
 *
 * Acceptance criteria verified here:
 *   1. Queries on tenant-scoped models throw TenantScopeError when schoolId
 *      is absent from the filter.
 *   2. Queries that include schoolId pass through normally.
 *   3. Aggregate pipelines must begin with a $match that includes schoolId.
 *   4. .bypassTenantScope() / { _bypassTenantScope: true } opts-out safely.
 *   5. CI fails when a new tenant query omits scope — enforced by points 1-3.
 */

const tenantScope = require('../backend/src/plugins/tenantScope');

const { TenantScopeError } = tenantScope;

// ── Schema stub ───────────────────────────────────────────────────────────────
// Captures the pre-hooks registered by the plugin without a real Mongoose Schema.

function makeSchema() {
  const hooks = {};
  const queryHelpers = {};

  return {
    pre(op, fn) {
      if (!hooks[op]) hooks[op] = [];
      hooks[op].push(fn);
    },
    query: queryHelpers,
    _hooks: hooks,
    _queryHelpers: queryHelpers,
  };
}

// ── Query stub ────────────────────────────────────────────────────────────────
// Matches the Mongoose Query interface used inside pre-hooks.

function makeQuery(filter = {}, options = {}) {
  return {
    getFilter: () => filter,
    getOptions: () => options,
    setOptions(opts) {
      Object.assign(options, opts);
      return this;
    },
  };
}

// ── Aggregate stub ────────────────────────────────────────────────────────────

function makeAggregate(pipeline = [], options = {}) {
  return {
    pipeline: () => pipeline,
    options,
    option(obj) {
      Object.assign(options, obj);
      return this;
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function runQueryHook(schema, op, query) {
  const hooks = schema._hooks[op] || [];
  for (const fn of hooks) {
    fn.call(query);
  }
}

function runAggregateHook(schema, aggregate) {
  const hooks = schema._hooks['aggregate'] || [];
  for (const fn of hooks) {
    fn.call(aggregate);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let schema;

beforeEach(() => {
  schema = makeSchema();
  tenantScope(schema, { modelName: 'TestModel' });
});

// ── TenantScopeError ──────────────────────────────────────────────────────────

describe('TenantScopeError', () => {
  test('is an Error subclass', () => {
    const err = new TenantScopeError('Student', 'find');
    expect(err).toBeInstanceOf(Error);
  });

  test('has expected properties', () => {
    const err = new TenantScopeError('Student', 'find');
    expect(err.name).toBe('TenantScopeError');
    expect(err.code).toBe('TENANT_SCOPE_MISSING');
    expect(err.modelName).toBe('Student');
    expect(err.operation).toBe('find');
  });

  test('message mentions schoolId and the model name', () => {
    const err = new TenantScopeError('Payment', 'aggregate');
    expect(err.message).toMatch(/schoolId/);
    expect(err.message).toMatch(/Payment/);
    expect(err.message).toMatch(/aggregate/);
  });
});

// ── Plugin registration ───────────────────────────────────────────────────────

describe('plugin registration', () => {
  const EXPECTED_OPS = [
    'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete',
    'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
    'countDocuments', 'distinct',
  ];

  test.each(EXPECTED_OPS)('registers pre("%s") hook', (op) => {
    expect(schema._hooks[op]).toBeDefined();
    expect(schema._hooks[op].length).toBeGreaterThan(0);
  });

  test('registers pre("aggregate") hook', () => {
    expect(schema._hooks['aggregate']).toBeDefined();
    expect(schema._hooks['aggregate'].length).toBeGreaterThan(0);
  });

  test('adds bypassTenantScope query helper', () => {
    expect(typeof schema.query.bypassTenantScope).toBe('function');
  });
});

// ── find / findOne ────────────────────────────────────────────────────────────

describe('find hook', () => {
  test('throws TenantScopeError when schoolId absent', () => {
    const q = makeQuery({ name: 'Alice' });
    expect(() => runQueryHook(schema, 'find', q)).toThrow(TenantScopeError);
  });

  test('throws when filter is empty', () => {
    const q = makeQuery({});
    expect(() => runQueryHook(schema, 'find', q)).toThrow(TenantScopeError);
  });

  test('does not throw when schoolId is present', () => {
    const q = makeQuery({ schoolId: 'school-a' });
    expect(() => runQueryHook(schema, 'find', q)).not.toThrow();
  });

  test('does not throw when schoolId is null (explicit null is still present as key)', () => {
    const q = makeQuery({ schoolId: null });
    expect(() => runQueryHook(schema, 'find', q)).not.toThrow();
  });

  test('bypasses when _bypassTenantScope option is set', () => {
    const q = makeQuery({}, { _bypassTenantScope: true });
    expect(() => runQueryHook(schema, 'find', q)).not.toThrow();
  });
});

describe('findOne hook', () => {
  test('throws when schoolId absent', () => {
    expect(() => runQueryHook(schema, 'findOne', makeQuery({ _id: 'abc' }))).toThrow(TenantScopeError);
  });

  test('passes with schoolId', () => {
    expect(() => runQueryHook(schema, 'findOne', makeQuery({ schoolId: 'x' }))).not.toThrow();
  });
});

// ── Write operations ──────────────────────────────────────────────────────────

describe.each(['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete'])(
  '%s hook',
  (op) => {
    test('throws when schoolId absent', () => {
      const q = makeQuery({ status: 'active' });
      expect(() => runQueryHook(schema, op, q)).toThrow(TenantScopeError);
    });

    test('passes when schoolId is present', () => {
      const q = makeQuery({ schoolId: 'school-a', status: 'active' });
      expect(() => runQueryHook(schema, op, q)).not.toThrow();
    });

    test('bypasses with _bypassTenantScope option', () => {
      const q = makeQuery({ status: 'active' }, { _bypassTenantScope: true });
      expect(() => runQueryHook(schema, op, q)).not.toThrow();
    });
  }
);

// ── countDocuments ────────────────────────────────────────────────────────────

describe('countDocuments hook', () => {
  test('throws when schoolId absent', () => {
    expect(() => runQueryHook(schema, 'countDocuments', makeQuery({}))).toThrow(TenantScopeError);
  });

  test('passes with schoolId', () => {
    expect(() => runQueryHook(schema, 'countDocuments', makeQuery({ schoolId: 's' }))).not.toThrow();
  });
});

// ── distinct ─────────────────────────────────────────────────────────────────

describe('distinct hook', () => {
  test('throws when schoolId absent', () => {
    expect(() => runQueryHook(schema, 'distinct', makeQuery({}))).toThrow(TenantScopeError);
  });

  test('passes with schoolId', () => {
    expect(() => runQueryHook(schema, 'distinct', makeQuery({ schoolId: 's' }))).not.toThrow();
  });
});

// ── aggregate ────────────────────────────────────────────────────────────────

describe('aggregate hook', () => {
  test('throws when pipeline is empty', () => {
    const agg = makeAggregate([]);
    expect(() => runAggregateHook(schema, agg)).toThrow(TenantScopeError);
  });

  test('throws when first stage is not $match', () => {
    const agg = makeAggregate([{ $group: { _id: '$schoolId' } }]);
    expect(() => runAggregateHook(schema, agg)).toThrow(TenantScopeError);
  });

  test('throws when first $match lacks schoolId', () => {
    const agg = makeAggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null } },
    ]);
    expect(() => runAggregateHook(schema, agg)).toThrow(TenantScopeError);
  });

  test('passes when first $match includes schoolId', () => {
    const agg = makeAggregate([
      { $match: { schoolId: 'school-a', status: 'active' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    expect(() => runAggregateHook(schema, agg)).not.toThrow();
  });

  test('bypasses with _bypassTenantScope in aggregate options', () => {
    const agg = makeAggregate(
      [{ $group: { _id: '$schoolId', count: { $sum: 1 } } }],
      { _bypassTenantScope: true }
    );
    expect(() => runAggregateHook(schema, agg)).not.toThrow();
  });

  test('error message names the model and operation', () => {
    const agg = makeAggregate([]);
    let caught;
    try { runAggregateHook(schema, agg); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TenantScopeError);
    expect(caught.message).toMatch(/TestModel/);
    expect(caught.message).toMatch(/aggregate/);
  });
});

// ── bypassTenantScope query helper ────────────────────────────────────────────

describe('bypassTenantScope() query helper', () => {
  test('sets _bypassTenantScope option on the query', () => {
    const opts = {};
    const q = makeQuery({}, opts);
    schema.query.bypassTenantScope.call(q);
    expect(opts._bypassTenantScope).toBe(true);
  });

  test('returns the query for chaining', () => {
    const q = makeQuery({}, {});
    const result = schema.query.bypassTenantScope.call(q);
    expect(result).toBe(q);
  });
});

// ── Error thrown is a TenantScopeError ────────────────────────────────────────

describe('error identity across operations', () => {
  const OPS_WITHOUT_SCOPE = [
    ['find',            () => makeQuery({ name: 'x' })],
    ['findOne',         () => makeQuery({ _id: 'y' })],
    ['countDocuments',  () => makeQuery({})],
    ['updateOne',       () => makeQuery({ active: true })],
    ['deleteMany',      () => makeQuery({ createdAt: { $lt: new Date() } })],
  ];

  test.each(OPS_WITHOUT_SCOPE)('%s throws TenantScopeError (not a generic Error)', (op, mkQuery) => {
    let caught;
    try { runQueryHook(schema, op, mkQuery()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TenantScopeError);
    expect(caught.code).toBe('TENANT_SCOPE_MISSING');
    expect(caught.operation).toBe(op);
    expect(caught.modelName).toBe('TestModel');
  });
});
