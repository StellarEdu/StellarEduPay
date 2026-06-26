'use strict';

/**
 * Soft Delete Utility (Issue #77, fix #390)
 *
 * Adds a `deletedAt` field and automatic query filtering so that soft-deleted
 * documents are invisible to all standard find/count operations.
 *
 * Bug fixed (#390): the original check `!query.deletedAt` is truthy when
 * deletedAt === null (the default value), so the filter was never applied.
 * The correct guard is `!('deletedAt' in query)` — only inject the filter
 * when the caller has not explicitly set a deletedAt condition.
 *
 * includeDeleted() query helper: call .includeDeleted() on any query to
 * bypass the automatic filter and retrieve all documents including deleted ones.
 */

const softDelete = (schema) => {
  // Add deletedAt field
  schema.add({
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  });

  // ── Instance methods ────────────────────────────────────────────────────────

  schema.methods.softDelete = async function () {
    this.deletedAt = new Date();
    return await this.save();
  };

  schema.methods.restore = async function () {
    this.deletedAt = null;
    return await this.save();
  };

  // ── Static methods ──────────────────────────────────────────────────────────

  schema.statics.softDelete = async function (filter) {
    return await this.updateMany(filter, { deletedAt: new Date() });
  };

  schema.statics.restore = async function (filter) {
    return await this.updateMany(filter, { deletedAt: null });
  };

  /**
   * .activeFilter() — return a filter object merged with { deletedAt: null }.
   *
   * Use this for operations the pre-hook does not cover (aggregate, distinct)
   * so that soft-deleted documents are always excluded from default reads.
   *
   * Usage:
   *   const match = Payment.activeFilter({ schoolId, status: 'SUCCESS' });
   *   Payment.aggregate([{ $match: match }, ...]);
   */
  schema.statics.activeFilter = function (filter = {}) {
    return { ...filter, deletedAt: null };
  };

  // ── Query helper ────────────────────────────────────────────────────────────

  /**
   * .includeDeleted() — bypass the automatic { deletedAt: null } filter.
   *
   * Usage:
   *   await Student.find({ schoolId }).includeDeleted()
   */
  schema.query.includeDeleted = function () {
    return this.setOptions({ _includeDeleted: true });
  };

  // ── Query middleware ────────────────────────────────────────────────────────

  /**
   * Automatically append { deletedAt: null } to every query unless:
   *   a) the caller already set a deletedAt condition (explicit override), or
   *   b) the caller used .includeDeleted() to opt out.
   *
   * Key fix: use `!('deletedAt' in query)` instead of `!query.deletedAt`.
   * The old check was falsy when deletedAt was null, so the filter was never
   * injected — soft-deleted records leaked into all query results.
   */
  const excludeDeleted = function (next) {
    if (this.getOptions()._includeDeleted) return next();
    const query = this.getQuery();
    if (!('deletedAt' in query)) {
      this.where({ deletedAt: null });
    }
    next();
  };

  schema.pre('find', excludeDeleted);
  schema.pre('findOne', excludeDeleted);
  schema.pre('findOneAndUpdate', excludeDeleted);
  schema.pre('countDocuments', excludeDeleted);
};

module.exports = softDelete;
