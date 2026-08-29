'use strict';

/**
 * PII Anonymization Scheduler
 *
 * Runs on a leader-only schedule to anonymize student PII (personally identifiable
 * information) after the retention window expires for soft-deleted students.
 *
 * Soft-deleted students have PII cleared once STUDENT_PII_RETENTION_DAYS has passed
 * since deletion. This implements data minimization principles from GDPR and similar
 * privacy frameworks by removing data no longer needed for operational purposes.
 *
 * Fields anonymized:
 *   - name                   → anonymized
 *   - dateOfBirth            → null
 *   - gender                 → null
 *   - parentName             → null
 *   - contactNumber          → null
 *   - parentPhone            → null
 */

const Student = require('../models/studentModel');
const logger = require('../utils/logger').child('PIIAnonymizationScheduler');
const config = require('../config');

const { STUDENT_PII_RETENTION_DAYS } = config;

let _timer = null;
let _running = false;
let _lastRunAt = null;

const ANONYMIZATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // Run daily

function isAnonymizationEnabled() {
  return STUDENT_PII_RETENTION_DAYS > 0;
}

async function anonymizeExpiredPii() {
  if (!isAnonymizationEnabled()) {
    logger.debug('PII anonymization disabled (STUDENT_PII_RETENTION_DAYS <= 0)');
    return { count: 0, error: null };
  }

  if (_running) {
    logger.debug('PII anonymization already running, skipping');
    return { count: 0, skipped: true };
  }

  _running = true;
  const startTime = Date.now();

  try {
    const cutoffDate = new Date(Date.now() - STUDENT_PII_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    logger.info('Starting PII anonymization', {
      retentionDays: STUDENT_PII_RETENTION_DAYS,
      cutoffDate,
    });

    // Find all soft-deleted students whose retention window has expired
    const result = await Student.updateMany(
      {
        deletedAt: {
          $ne: null,
          $lte: cutoffDate,
        },
        // Avoid re-anonymizing already-cleared records
        $or: [
          { name: { $ne: 'Anonymized' } },
          { dateOfBirth: { $ne: null } },
          { gender: { $ne: null } },
          { parentName: { $ne: null } },
          { contactNumber: { $ne: null } },
          { parentPhone: { $ne: null } },
        ],
      },
      {
        $set: {
          name: 'Anonymized',
          dateOfBirth: null,
          gender: null,
          parentName: null,
          contactNumber: null,
          parentPhone: null,
        },
      }
    );

    _lastRunAt = new Date();
    const duration = Date.now() - startTime;

    logger.info('PII anonymization completed', {
      count: result.modifiedCount,
      duration: `${duration}ms`,
    });

    return { count: result.modifiedCount, duration };
  } catch (err) {
    logger.error('PII anonymization failed', { error: err.message });
    return { count: 0, error: err.message };
  } finally {
    _running = false;
  }
}

function startPiiAnonymizationScheduler() {
  if (_timer) {
    logger.warn('PII anonymization scheduler already started');
    return;
  }

  logger.info('PII anonymization scheduler started', {
    retentionDays: STUDENT_PII_RETENTION_DAYS,
    intervalMs: ANONYMIZATION_INTERVAL_MS,
  });

  _timer = setInterval(() => {
    anonymizeExpiredPii().catch((err) => {
      logger.error('Unhandled error in PII anonymization scheduler', { error: err.message });
    });
  }, ANONYMIZATION_INTERVAL_MS);
}

function stopPiiAnonymizationScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('PII anonymization scheduler stopped');
  }
}

module.exports = {
  startPiiAnonymizationScheduler,
  stopPiiAnonymizationScheduler,
  anonymizeExpiredPii,
  getLastRunAt: () => _lastRunAt,
};
