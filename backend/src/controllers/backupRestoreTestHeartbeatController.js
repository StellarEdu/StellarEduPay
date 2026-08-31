'use strict';

/**
 * backupRestoreTestHeartbeatController
 *
 * Handles POST /api/internal/backup-restore-test-heartbeat.
 * Called by the weekly backup-restore-test CI job
 * (.github/workflows/backup-restore-test.yml) after
 * scripts/test-backup-recovery.sh succeeds, so
 * last_backup_restore_test_age_seconds stays current. See issue #1413.
 */

const { recordBackupRestoreTestSuccess } = require('../metrics');
const logger = require('../utils/logger');

function backupRestoreTestHeartbeat(req, res) {
  const token = process.env.BACKUP_NOTIFY_TOKEN;

  if (!token) {
    logger.warn('backup-restore-test-heartbeat: BACKUP_NOTIFY_TOKEN is not set — endpoint disabled');
    return res.status(503).json({ error: 'Backup restore test heartbeat endpoint is not configured' });
  }

  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!provided || provided !== token) {
    logger.warn('backup-restore-test-heartbeat: unauthorised request (token mismatch or missing)');
    return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  recordBackupRestoreTestSuccess(nowSeconds);

  logger.info('backup-restore-test-heartbeat: restore test success recorded', { timestamp: nowSeconds });
  return res.status(200).json({ recorded: nowSeconds });
}

module.exports = { backupRestoreTestHeartbeat };
