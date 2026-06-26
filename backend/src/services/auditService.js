'use strict';

const AuditLog = require('../models/auditLogModel');
const logger = require('../utils/logger');

// In-process failure counter — reset on restart (acceptable for single-process deployments)
let _auditFailureCount = 0;

/** Returns the current audit log failure count and health status. */
function getAuditHealth() {
  return {
    status: _auditFailureCount === 0 ? 'ok' : 'degraded',
    recentFailures: _auditFailureCount,
  };
}

/** Exposed for testing only. */
function _resetAuditFailureCount() {
  _auditFailureCount = 0;
}

/**
 * logAudit — creates an audit log entry for admin actions.
 *
 * @param {Object} params
 * @param {string} params.schoolId - School context
 * @param {string} params.action - Action performed (e.g., 'student_create', 'payment_reset')
 * @param {string} params.performedBy - Admin user identifier (email or userId from JWT)
 * @param {string} params.targetId - ID of the affected resource
 * @param {string} params.targetType - Type of resource ('student', 'payment', 'fee', 'school')
 * @param {Object} params.details - Additional context (before/after values, etc.)
 * @param {string} params.result - 'success' or 'failure'
 * @param {string} params.errorMessage - Error details if result is 'failure'
 * @param {string} params.ipAddress - Client IP address
 * @param {string} params.userAgent - Client user agent
 */
async function logAudit({
  schoolId,
  action,
  performedBy,
  targetId,
  targetType,
  details = {},
  result = 'success',
  errorMessage = null,
  ipAddress = null,
  userAgent = null,
  severity = null,
}) {
  try {
    await AuditLog.create({
      schoolId,
      action,
      performedBy,
      targetId,
      targetType,
      details,
      result,
      errorMessage,
      ipAddress,
      userAgent,
      ...(severity ? { severity } : {}),
    });
  } catch (err) {
    // Do NOT re-throw — audit failure must not break the primary operation
    _auditFailureCount += 1;
    logger.error('AUDIT_LOG_FAILURE', { err, schoolId, action });
  }
}

/**
 * getAuditLogs — retrieves audit logs with filtering and pagination.
 *
 * Supports two pagination modes:
 *  - Cursor-based (preferred for large datasets): pass `cursor` (opaque token
 *    from a prior response's `nextCursor`). Uses the compound index
 *    { schoolId, createdAt } — no collection scan, O(1) seek.
 *  - Page/offset (backward-compatible): pass `page` + `limit`. Limited to
 *    MAX_PAGE_SIZE results; avoid large page numbers on high-volume schools.
 *
 * @param {Object} filters
 * @param {string} filters.schoolId   - Required school context
 * @param {string} filters.action     - Filter by action type
 * @param {string} filters.targetType - Filter by target type
 * @param {string} filters.performedBy - Filter by actor (admin user)
 * @param {string} filters.result     - Filter by result ('success' | 'failure')
 * @param {Date}   filters.startDate  - Filter by date range start (ISO 8601)
 * @param {Date}   filters.endDate    - Filter by date range end (ISO 8601)
 * @param {string} filters.cursor     - Opaque cursor from a prior response
 * @param {number} filters.page       - Page number for offset pagination (default: 1)
 * @param {number} filters.limit      - Results per page (default: 50, max: 200)
 */
const MAX_PAGE_SIZE = 200;

async function getAuditLogs(filters = {}) {
  const {
    schoolId,
    action,
    targetType,
    performedBy,
    result,
    startDate,
    endDate,
    cursor,
    page = 1,
    limit = 50,
  } = filters;

  const baseQuery = { schoolId };

  if (action) baseQuery.action = action;
  if (targetType) baseQuery.targetType = targetType;
  if (performedBy) baseQuery.performedBy = performedBy;
  if (result) baseQuery.result = result;

  if (startDate || endDate) {
    baseQuery.createdAt = {};
    if (startDate) baseQuery.createdAt.$gte = new Date(startDate);
    if (endDate) baseQuery.createdAt.$lte = new Date(endDate);
  }

  const actualLimit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);

  if (cursor) {
    // Cursor-based pagination: decode the cursor to get { createdAt, _id }
    // and page forward using a range predicate on the compound index.
    let cursorData;
    try {
      cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    } catch {
      const err = new Error('Invalid pagination cursor');
      err.code = 'INVALID_CURSOR';
      throw err;
    }

    const query = { ...baseQuery };
    // Continue from where the previous page left off. Documents are sorted
    // { createdAt: -1 }, so "next page" means createdAt < cursorCreatedAt,
    // or same createdAt with a smaller _id (tie-break).
    query.$or = [
      { createdAt: { $lt: new Date(cursorData.createdAt) } },
      {
        createdAt: new Date(cursorData.createdAt),
        _id: { $lt: cursorData._id },
      },
    ];

    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(actualLimit)
      .lean();

    const nextCursor =
      logs.length === actualLimit
        ? Buffer.from(
            JSON.stringify({
              createdAt: logs[logs.length - 1].createdAt,
              _id: logs[logs.length - 1]._id,
            }),
          ).toString('base64')
        : null;

    return { logs, limit: actualLimit, nextCursor };
  }

  // Offset-based pagination (page/limit) — kept for backward compatibility.
  const skip = (page - 1) * actualLimit;

  const [logs, total] = await Promise.all([
    AuditLog.find(baseQuery)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(actualLimit)
      .lean(),
    AuditLog.countDocuments(baseQuery),
  ]);

  const nextCursor =
    skip + logs.length < total && logs.length > 0
      ? Buffer.from(
          JSON.stringify({
            createdAt: logs[logs.length - 1].createdAt,
            _id: logs[logs.length - 1]._id,
          }),
        ).toString('base64')
      : null;

  return {
    logs,
    total,
    page,
    limit: actualLimit,
    pages: Math.ceil(total / actualLimit) || 1,
    nextCursor,
  };
}

/**
 * getRecentAuditLogs — retrieves the most recent audit logs for dashboard display.
 *
 * @param {string} schoolId - School context
 * @param {number} limit - Number of recent logs to retrieve (default: 10)
 */
async function getRecentAuditLogs(schoolId, limit = 10) {
  return await AuditLog.find({ schoolId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = { logAudit, getAuditLogs, getRecentAuditLogs, getAuditHealth, _resetAuditFailureCount };
