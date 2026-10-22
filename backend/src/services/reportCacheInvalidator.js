'use strict';

/**
 * reportCacheInvalidator.js
 *
 * Invalidates school-scoped report cache entries when a new payment is saved.
 *
 * Report queries are cached in cache.js under keys of the form
 *   report:<schoolId>:<startDate>:<endDate>:v<dataVersion>
 *
 * When a payment lands the cached reports for that school are immediately
 * stale. Rather than waiting for the 5-minute TTL to expire, this subscriber
 * drops them as soon as the payment.saved event fires so the next request
 * fetches fresh data.
 *
 * The invalidation is best-effort: a failure here is logged and swallowed so
 * that a broken cache layer can never block payment recording.
 */

const { delByPrefix } = require('../cache');
const logger = require('../utils/logger').child('ReportCacheInvalidator');

/**
 * Invalidate all report cache entries for the school that just received a
 * payment.
 *
 * @param {object} payment - The saved payment document (must have .schoolId).
 */
function invalidateReportCache(payment) {
  try {
    if (!payment || !payment.schoolId) return;
    const prefix = `report:${payment.schoolId}:`;
    delByPrefix(prefix);
    logger.debug('Report cache invalidated', { schoolId: payment.schoolId });
  } catch (err) {
    logger.error('Report cache invalidation failed', {
      schoolId: payment && payment.schoolId,
      error: err.message,
    });
  }
}

module.exports = { invalidateReportCache };
