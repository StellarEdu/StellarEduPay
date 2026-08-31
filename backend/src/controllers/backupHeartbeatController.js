'use strict';

/**
 * backupHeartbeatController
 *
 * Handles POST /api/internal/backup-heartbeat.
 * Extracted from internalRoutes so it can be unit-tested without Express.
 * See issue #1102.
 */

const { backupLastSuccessTimestamp } = require('../metrics');
const logger = require('../utils/logger');

/**
 * POST /api/internal/backup-heartbeat
 *
 * Called by scripts/backup.sh immediately after a successful backup so that
 * the backup_last_success_timestamp_seconds Prometheus metric stays current.
 *
 * Authentication: Bearer token in the Authorization header, matched against
 * BACKUP_NOTIFY_TOKEN from the environment.
 */
function backupHeartbeat(req, res) {
  const token = process.env.BACKUP_NOTIFY_TOKEN;

  if (!token) {
    logger.warn('backup-heartbeat: BACKUP_NOTIFY_TOKEN is not set — endpoint disabled');
    return res.status(503).json({ error: 'Backup heartbeat endpoint is not configured' });
  }

  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!provided || provided !== token) {
    logger.warn('backup-heartbeat: unauthorised request (token mismatch or missing)');
    return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  backupLastSuccessTimestamp.set(nowSeconds);

  logger.info('backup-heartbeat: backup success recorded', { timestamp: nowSeconds });
  return res.status(200).json({ recorded: nowSeconds });
}

module.exports = { backupHeartbeat };
