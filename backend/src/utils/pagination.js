'use strict';

/**
 * Shared pagination parsing for list endpoints.
 *
 * Guarantees:
 *  - Never returns NaN for `page` or `limit`.
 *  - `limit` is always an integer in [1, maxLimit].
 *  - `page` is always an integer >= 1.
 *  - Out-of-range / non-numeric values are clamped (or rejected when
 *    `strict` is requested), never passed through to the DB driver.
 */

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LIMIT = 200;

/**
 * Parse a single numeric query value.
 * Returns `undefined` when the value is absent or not a finite number.
 *
 * @param {*} value
 * @returns {number|undefined}
 */
function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  // Reject arrays / objects (e.g. ?limit=1&limit=2 -> ['1','2']).
  if (typeof value === 'object') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

/**
 * Parse pagination params from an Express request.
 *
 * @param {object} req - Express request (must have `req.query`).
 * @param {object} [options]
 * @param {number} [options.defaultLimit=50] - limit used when absent/invalid.
 * @param {number} [options.maxLimit=200] - hard upper bound for limit.
 * @param {number} [options.defaultPage=1] - page used when absent/invalid.
 * @param {boolean} [options.strict=false] - when true, invalid values are
 *   reported via `error` instead of being clamped.
 * @returns {{ page: number, limit: number, skip: number, error?: string }}
 */
function parsePagination(req, options = {}) {
  const {
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = DEFAULT_MAX_LIMIT,
    defaultPage = 1,
    strict = false,
  } = options;

  const safeDefaultLimit = Math.min(
    Math.max(1, Number.isFinite(defaultLimit) ? Math.trunc(defaultLimit) : DEFAULT_LIMIT),
    maxLimit
  );
  const safeMaxLimit = Number.isFinite(maxLimit) && maxLimit >= 1 ? Math.trunc(maxLimit) : DEFAULT_MAX_LIMIT;

  const query = (req && req.query) || {};

  const rawLimit = query.limit;
  const rawPage = query.page;

  let limit = toFiniteNumber(rawLimit);
  let page = toFiniteNumber(rawPage);

  let error;

  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    if (limit === undefined) {
      error = 'limit must be an integer';
    } else if (limit < 1) {
      error = 'limit must be at least 1';
    } else if (limit > safeMaxLimit) {
      error = `limit must not exceed ${safeMaxLimit}`;
    }
  }

  if (!error && rawPage !== undefined && rawPage !== null && rawPage !== '') {
    if (page === undefined) {
      error = 'page must be an integer';
    } else if (page < 1) {
      error = 'page must be at least 1';
    }
  }

  if (error && strict) {
    return {
      page: defaultPage,
      limit: safeDefaultLimit,
      skip: 0,
      error,
    };
  }

  // Clamp (non-strict) or fall back to defaults.
  if (limit === undefined) {
    limit = safeDefaultLimit;
  }
  limit = Math.min(Math.max(1, Math.trunc(limit)), safeMaxLimit);

  if (page === undefined) {
    page = defaultPage;
  }
  page = Math.max(1, Math.trunc(page));

  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

module.exports = {
  parsePagination,
  DEFAULT_LIMIT,
  DEFAULT_MAX_LIMIT,
};