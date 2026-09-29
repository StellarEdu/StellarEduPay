'use strict';

const logger = require('../utils/logger');
const { logAudit } = require('../services/auditService');
const SystemConfig = require('../models/systemConfigModel');
const { invalidateMaintenanceCache } = require('../middleware/maintenanceMode');

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

/**
 * PUT /api/admin/maintenance
 * Body: { enabled: boolean, message?: string }
 * Requires super-admin auth. Toggles global maintenance mode and invalidates
 * the in-memory cache used by the maintenanceMode middleware.
 */
async function setMaintenanceMode(req, res, next) {
  try {
    const { enabled, message } = req.body || {};

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'Invalid maintenance flag. "enabled" must be a boolean.',
        code: 'INVALID_MAINTENANCE_FLAG',
      });
    }

    const previous = await SystemConfig.get('maintenanceMode');
    const previousEnabled = !!(previous && previous.enabled);

    const value = { enabled };
    if (typeof message === 'string') {
      value.message = message;
    }

    await SystemConfig.set('maintenanceMode', value);
    invalidateMaintenanceCache();

    logger.info('Global maintenance mode changed', {
      previous: previousEnabled,
      current: enabled,
      changedBy: req.admin?.email || req.admin?.userId,
    });

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'maintenance_mode_change',
        performedBy: req.auditContext.performedBy,
        targetId: 'maintenanceMode',
        targetType: 'system_config',
        details: { previous: previousEnabled, current: enabled },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ previous: previousEnabled, current: enabled });
  } catch (err) {
    next(err);
  }
}

module.exports = { setLogLevel, setMaintenanceMode };
