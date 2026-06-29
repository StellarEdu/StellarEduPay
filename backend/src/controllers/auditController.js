'use strict';

const { getAuditLogs, getRecentAuditLogs, verifyAuditChain } = require('../services/auditService');

/**
 * GET /api/audit-logs
 *
 * Query parameters:
 *   - action: filter by action type
 *   - targetType: filter by target type (student, payment, fee, school)
 *   - performedBy: filter by actor (admin user)
 *   - startDate: filter by date range (ISO 8601)
 *   - endDate: filter by date range (ISO 8601)
 *   - cursor: opaque pagination cursor from a prior response's nextCursor field
 *   - page: page number for offset pagination (default: 1; ignored when cursor is set)
 *   - limit: results per page (default: 50, max: 200)
 */
async function getAuditLogsEndpoint(req, res, next) {
  try {
    const { schoolId } = req;
    const { action, targetType, performedBy, result, startDate, endDate, cursor, page, limit } = req.query;

    const auditResult = await getAuditLogs({
      schoolId,
      action,
      targetType,
      performedBy,
      result,
      startDate,
      endDate,
      cursor: cursor || null,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    res.json(auditResult);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit-logs/recent
 *
 * Returns the most recent audit logs for dashboard display.
 *
 * Query parameters:
 *   - limit: number of recent logs (default: 10, max: 50)
 */
async function getRecentAuditLogsEndpoint(req, res, next) {
  try {
    const { schoolId } = req;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

    const logs = await getRecentAuditLogs(schoolId, limit);
    res.json(logs);
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuditLogsEndpoint, getRecentAuditLogsEndpoint, verifyChainEndpoint };

async function verifyChainEndpoint(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const report = await verifyAuditChain(req.schoolId, { limit });
    res.json(report);
  } catch (err) {
    next(err);
  }
}
