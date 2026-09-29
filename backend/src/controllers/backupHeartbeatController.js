'use strict';

/**
 * backupHeartbeatController
 *
 * Handles POST /api/internal/backup-heartbeat.
 * Extracted from internalRoutes so it can be unit-tested without Express.
 * See issue #1102.
 *
 * The last-success timestamp is persisted (SystemConfig key
 * `backupLastSuccessAt`) so that every replica exposes the same value and it
 * survives restarts. See issue #1593.
 */

const { backupLastSuccessTimestamp } = require('../metrics');
const SystemConfig = require('../models/SystemConfig');
const logger = require('../utils/logger');

const BACKUP_LAST_SUCCESS_KEY = 'backupLastSuccessAt';

/**
 * Read the persisted last-success timestamp (seconds) and sync the in-process
 * gauge so every replica exposes a consistent value. Returns the timestamp or
 * null when no backup has been recorded yet.
 */
async function syncBackupLastSuccess() {
  const config = await SystemConfig.findOne({ where: { key: BACKUP_LAST_SUCCESS_KEY } });
  const value = config ? Number(config.value) : NaN;

  if (Number.isFinite(value) && value > 0) {
    backupLastSuccessTimestamp.set(value);
    return value;
  }

  return null;
}

/**
 * POST /api/internal/backup-heartbeat
 *
 * Called by scripts/backup.sh immediately after a successful backup so that
 * the backup_last_success_timestamp_seconds Prometheus metric stays current.
 *
 * Authentication: Bearer token in the Authorization header, matched against
 * BACKUP_NOTIFY_TOKEN from the environment.
 */
async function backupHeartbeat(req, res) {
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

  try {
    const [config] = await SystemConfig.findOrCreate({
      where: { key: BACKUP_LAST_SUCCESS_KEY },
      defaults: { key: BACKUP_LAST_SUCCESS_KEY, value: String(nowSeconds) },
    });

    if (config.value !== String(nowSeconds)) {
      config.value = String(nowSeconds);
      await config.save();
    }
  } catch (err) {
    logger.error('backup-heartbeat: failed to persist last-success timestamp', {
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to record backup heartbeat' });
  }

  backupLastSuccessTimestamp.set(nowSeconds);

  logger.info('backup-heartbeat: backup success recorded', { timestamp: nowSeconds });
  return res.status(200).json({ recorded: nowSeconds });
}

module.exports = { backupHeartbeat, syncBackupLastSuccess, BACKUP_LAST_SUCCESS_KEY };
