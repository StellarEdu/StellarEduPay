'use strict';

const PaymentIntent = require('../models/paymentIntentModel');
const auditService = require('./auditService');
const logger = require('../utils/logger').child('SessionCleanupService');

const INTERVAL_MS = parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS, 10) || 60 * 60 * 1000;
const BATCH_SIZE = 1000;
let _timer = null;
let _running = false;

async function cleanupExpiredSessions() {
  if (_running) return;
  _running = true;
  try {
    let totalModified = 0;

    // Process expired intents in bounded batches so a large backlog does not
    // hold a single long-running query/update.
    for (;;) {
      // Cross-tenant infrastructure sweep: this job expires intents for every
      // school, so it must bypass the tenantScope plugin (no schoolId filter).
      const expiredIntents = await PaymentIntent.find({ status: 'pending', expiresAt: { $lt: new Date() } })
        .select('_id schoolId studentId expiresAt')
        .limit(BATCH_SIZE)
        .bypassTenantScope()
        .lean();

      if (expiredIntents.length === 0) break;

      const ids = expiredIntents.map((intent) => intent._id);

      // Same cross-tenant bypass: the update spans all schools.
      const result = await PaymentIntent.updateMany(
        { _id: { $in: ids }, status: 'pending' },
        { $set: { status: 'expired' } },
        { _bypassTenantScope: true }
      );

      totalModified += result.modifiedCount || 0;

      // Group by schoolId and studentId for bulk audit logging
      const auditBySchoolStudent = {};
      for (const intent of expiredIntents) {
        const key = `${intent.schoolId}:${intent.studentId}`;
        if (!auditBySchoolStudent[key]) {
          auditBySchoolStudent[key] = { schoolId: intent.schoolId, studentId: intent.studentId, sessions: [] };
        }
        auditBySchoolStudent[key].sessions.push({
          sessionId: intent._id.toString(),
          expiredAt: intent.expiresAt,
        });
      }

      // Create audit log entries for each school-student combination
      for (const key in auditBySchoolStudent) {
        const audit = auditBySchoolStudent[key];
        await auditService.logAudit({
          schoolId: audit.schoolId,
          action: 'SESSION_EXPIRED',
          performedBy: 'system',
          targetId: audit.studentId,
          targetType: 'student',
          details: {
            sessionCount: audit.sessions.length,
            sessions: audit.sessions,
            purgedAt: new Date(),
          },
          result: 'success',
        });
      }

      // Stop when the batch was not full, or when nothing was actually
      // modified (avoids re-reading the same pending docs forever).
      if (expiredIntents.length < BATCH_SIZE || !result.modifiedCount) break;
    }

    if (totalModified > 0) {
      logger.info('Expired sessions cleaned up', { count: totalModified });
    }
  } catch (err) {
    logger.error('Session cleanup failed', { error: err.message });
  } finally {
    _running = false;
  }
}

function startSessionCleanupScheduler() {
  if (_timer) return;
  _timer = setInterval(cleanupExpiredSessions, INTERVAL_MS);
  _timer.unref();
}

function stopSessionCleanupScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startSessionCleanupScheduler, stopSessionCleanupScheduler, cleanupExpiredSessions };
