'use strict';

const AuditLog = require('../models/auditLogModel');
const logger = require('../utils/logger');

const INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS, 10) || 730;
let _timer = null;

async function cleanupExpiredLogs() {
  try {
    const expiry = new Date(Date.now() - RETENTION_DAYS * 86400000);
    // Cross-school cleanup by design: TTL enforcement must span all tenants.
    const result = await AuditLog.deleteMany({ createdAt: { $lt: expiry } }).bypassTenantScope().limit(1000);
    if (result.deletedCount > 0) logger.info('AUDIT_LOG_CLEANUP', { deletedCount: result.deletedCount });
  } catch (err) {
    logger.error('AUDIT_LOG_CLEANUP_FAILED', { error: err.message });
  }
}

function startAuditLogCleanupScheduler() {
  if (_timer) return;
  _timer = setInterval(cleanupExpiredLogs, INTERVAL_MS);
  _timer.unref();
}

function stopAuditLogCleanupScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startAuditLogCleanupScheduler, stopAuditLogCleanupScheduler };
