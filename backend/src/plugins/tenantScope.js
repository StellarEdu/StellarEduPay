'use strict';

/**
 * tenantScope — Mongoose plugin that enforces schoolId on all queries against
 * tenant-scoped models.
 *
 * Problem: convention-only scoping means a single omitted schoolId filter
 * can silently leak or mutate another tenant's data. This plugin turns the
 * convention into a hard invariant: every query must carry schoolId, or it
 * throws TenantScopeError at call time — before any database round-trip.
 *
 * Usage:
 *   const tenantScope = require('../plugins/tenantScope');
 *   schema.plugin(tenantScope, { modelName: 'Student' });
 *
 * Bypass (infrastructure ops that must span schools — use sparingly):
 *   // Query bypass helper:
 *   await Model.find({ status: 'pending' }).bypassTenantScope()
 *   // Or via setOptions:
 *   await Model.findOneAndUpdate(filter, update, { _bypassTenantScope: true })
 *   // Aggregate bypass:
 *   await Model.aggregate([...]).option({ _bypassTenantScope: true })
 */

class TenantScopeError extends Error {
  constructor(modelName, operation) {
    super(
      `[TenantScope] "${operation}" on tenant-scoped model "${modelName}" ` +
      `is missing required "schoolId" filter. ` +
      `Every query on a tenant-scoped model must include schoolId. ` +
      `For cross-tenant infrastructure operations, chain .bypassTenantScope() ` +
      `or pass { _bypassTenantScope: true } in options.`
    );
    this.name = 'TenantScopeError';
    this.code = 'TENANT_SCOPE_MISSING';
    this.modelName = modelName;
    this.operation = operation;
  }
}

// All query-type middleware hooks that accept a filter and could expose data.
// estimatedDocumentCount is intentionally omitted — it takes no filter.
const SCOPED_QUERY_TYPES = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
  'replaceOne',
];

function tenantScopePlugin(schema, options = {}) {
  const modelName = options.modelName || 'unknown';

  // Query helper — mirrors softDelete's .includeDeleted() pattern.
  // Callers chain .bypassTenantScope() on queries that legitimately span schools.
  schema.query.bypassTenantScope = function () {
    return this.setOptions({ _bypassTenantScope: true });
  };

  function assertSchoolId(filter, op) {
    if (!filter || !Object.prototype.hasOwnProperty.call(filter, 'schoolId')) {
      throw new TenantScopeError(modelName, op);
    }
  }

  for (const op of SCOPED_QUERY_TYPES) {
    schema.pre(op, function () {
      if (this.getOptions()._bypassTenantScope) return;
      assertSchoolId(this.getFilter(), op);
    });
  }

  // Aggregate middleware — this context is the Aggregate instance.
  // Requires schoolId in the first $match stage of the pipeline.
  schema.pre('aggregate', function () {
    if (this.options && this.options._bypassTenantScope) return;
    const pipeline = this.pipeline();
    const first = pipeline[0];
    if (
      !first ||
      !first.$match ||
      !Object.prototype.hasOwnProperty.call(first.$match, 'schoolId')
    ) {
      throw new TenantScopeError(modelName, 'aggregate');
    }
  });
}

tenantScopePlugin.TenantScopeError = TenantScopeError;

module.exports = tenantScopePlugin;
