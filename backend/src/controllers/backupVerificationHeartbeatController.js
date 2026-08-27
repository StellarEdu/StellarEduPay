'use strict';

/**
 * backupVerificationHeartbeatController
 *
 * Handles POST /api/internal/backup-verification-heartbeat.
 * Called by scripts/test-backup-recovery.sh on a successful restore-and-verify
 * run so last_backup_verification_age_seconds stays current. See issue #1343.
 */

const { recordBackupVerificationSuccess } = require('../metrics');
const logger = require('../utils/logger');

function backupVerificationHeartbeat(req, res) {
  const token = process.env.BACKUP_NOTIFY_TOKEN;

  if (!token) {
    logger.warn('backup-verification-heartbeat: BACKUP_NOTIFY_TOKEN is not set — endpoint disabled');
    return res.status(503).json({ error: 'Backup verification heartbeat endpoint is not configured' });
  }

  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!provided || provided !== token) {
    logger.warn('backup-verification-heartbeat: unauthorised request (token mismatch or missing)');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  recordBackupVerificationSuccess(nowSeconds);

  logger.info('backup-verification-heartbeat: verification success recorded', { timestamp: nowSeconds });
  return res.status(200).json({ recorded: nowSeconds });
}

module.exports = { backupVerificationHeartbeat };
