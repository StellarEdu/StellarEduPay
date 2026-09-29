'use strict';

const logger = require('../utils/logger');
const { logAudit } = require('../services/auditService');

const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * POST /api/admin/log-level
 * Body: { level: 'debug' | 'info' | 'warn' | 'error' }
 * Requires admin auth.
 *
 * Express 5 forwards rejected promises from async handlers to the global
 * error handler automatically, so the manual try/catch/next wrapper is no
 * longer required.
 */
async function setLogLevel(req, res) {
  const { level } = req.body;

  if (!level || !VALID_LEVELS.includes(level.toLowerCase())) {
    return res.status(400).json({
      error: `Invalid log level. Must be one of: ${VALID_LEVELS.join(', ')}`,
      code: 'INVALID_LOG_LEVEL',
    });
  }

  const previous = logger.getLevel();
  logger.setLevel(level);
  const current = logger.getLevel();

  logger.info('Log level changed at runtime', { previous, current, changedBy: req.admin?.email || req.admin?.userId });

  // Audit log (no schoolId for system-level actions)
  if (req.auditContext) {
    await logAudit({
      schoolId: 'system',
      action: 'log_level_change',
      performedBy: req.auditContext.performedBy,
      targetId: 'log_level',
      targetType: 'system_config',
      details: { previous, current },
      result: 'success',
      ipAddress: req.auditContext.ipAddress,
      userAgent: req.auditContext.userAgent,
    });
  }

  res.json({ previous, current });
}

module.exports = { setLogLevel };
