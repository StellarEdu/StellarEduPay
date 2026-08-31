'use strict';

/**
 * POST /api/internal/backup-heartbeat
 *
 * Called by scripts/backup.sh immediately after a successful backup so that
 * the backup_last_success_timestamp_seconds Prometheus metric stays current.
 * See issue #1102 and backupHeartbeatController for implementation details.
 */

const express = require('express');
const router = express.Router();
const { backupHeartbeat } = require('../controllers/backupHeartbeatController');
const { backupVerificationHeartbeat } = require('../controllers/backupVerificationHeartbeatController');
const { backupRestoreTestHeartbeat } = require('../controllers/backupRestoreTestHeartbeatController');

router.post('/backup-heartbeat', backupHeartbeat);
router.post('/backup-verification-heartbeat', backupVerificationHeartbeat);
router.post('/backup-restore-test-heartbeat', backupRestoreTestHeartbeat);

module.exports = router;
