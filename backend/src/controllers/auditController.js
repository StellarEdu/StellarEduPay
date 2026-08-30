'use strict';

const { getAuditLogs, getRecentAuditLogs, verifyAuditChain, exportAuditLogs } = require('../services/auditService');

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
    const { action, targetType, performedBy, result, search, startDate, endDate, cursor, page, limit } = req.query;

    // Validate page and limit as positive integers if provided
    if (page && (isNaN(parseInt(page, 10)) || parseInt(page, 10) < 1)) {
      return res.status(400).json({ error: 'page must be a positive integer', code: 'VALIDATION_ERROR' });
    }
    if (limit && (isNaN(parseInt(limit, 10)) || parseInt(limit, 10) < 1)) {
      return res.status(400).json({ error: 'limit must be a positive integer', code: 'VALIDATION_ERROR' });
    }

    const auditResult = await getAuditLogs({
      schoolId,
      action,
      targetType,
      performedBy,
      result,
      search,
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

/**
 * GET /api/audit/export
 *
 * Download all matching audit logs as CSV or JSON (for compliance exports).
 *
 * Query parameters (all optional):
 *   - format:      'csv' (default) or 'json'
 *   - action, targetType, performedBy, result: same filters as GET /api/audit
 *   - startDate, endDate: ISO 8601 date range
 *   - limit: max rows to export (default/max: 10 000)
 *
 * CSV columns: _id, schoolId, action, targetType, targetId, performedBy,
 *              result, errorMessage, ipAddress, createdAt
 */
async function exportAuditLogsEndpoint(req, res, next) {
  try {
    const { schoolId } = req;
    const {
      format = 'csv',
      action, targetType, performedBy, result,
      startDate, endDate, limit,
    } = req.query;

    const logs = await exportAuditLogs({
      schoolId, action, targetType, performedBy, result,
      startDate, endDate, limit,
    });

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-export.json"');
      return res.json(logs);
    }

    // Default: CSV
    const CSV_COLUMNS = [
      '_id', 'schoolId', 'action', 'targetType', 'targetId',
      'performedBy', 'result', 'errorMessage', 'ipAddress', 'createdAt',
    ];

    function escapeCsv(value) {
      if (value == null) return '';
      const str = String(value);
      // Wrap in double-quotes if value contains a comma, newline, or double-quote
      if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    const header = CSV_COLUMNS.join(',');
    const rows = logs.map((log) =>
      CSV_COLUMNS.map((col) => escapeCsv(log[col])).join(',')
    );
    const csv = [header, ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
    return res.send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuditLogsEndpoint, getRecentAuditLogsEndpoint, verifyChainEndpoint, exportAuditLogsEndpoint };

async function verifyChainEndpoint(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const report = await verifyAuditChain(req.schoolId, { limit });
    res.json(report);
  } catch (err) {
    next(err);
  }
}
