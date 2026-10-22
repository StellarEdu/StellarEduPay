'use strict';

/**
 * Pure helpers for the super-admin operations overview (#1817).
 * The controller gathers the raw counts; these functions turn them into the
 * per-school rows and the "is payment detection working?" signal.
 */

// A school whose last successful poll is older than this is reported as delayed.
const DEFAULT_DELAYED_AFTER_MS = 15 * 60 * 1000;

/**
 * @param {Date|string|null} lastSyncAt  time of the last successful poll
 * @param {number} [now=Date.now()]
 * @param {number} [delayedAfterMs]
 * @returns {'never_synced'|'operational'|'delayed'}
 */
function classifyPaymentDetection(lastSyncAt, now = Date.now(), delayedAfterMs = DEFAULT_DELAYED_AFTER_MS) {
  if (!lastSyncAt) return 'never_synced';
  const syncedAt = new Date(lastSyncAt).getTime();
  if (Number.isNaN(syncedAt)) return 'never_synced';
  return now - syncedAt > delayedAfterMs ? 'delayed' : 'operational';
}

/**
 * Builds one operations row for a school from pre-aggregated counts.
 *
 * @param {object} school            { schoolId, name, isActive, syncCursor, ingestStartsAt }
 * @param {object} counts
 * @param {Date|string|null} counts.lastSyncAt
 * @param {Object<string, number>} counts.verifications  status -> count for this school
 * @param {number} counts.webhookDeadLetters
 * @param {number} [now=Date.now()]
 */
function buildSchoolOpsRow(school, counts, now = Date.now()) {
  const lastSyncAt = counts.lastSyncAt || null;
  const syncedAt = lastSyncAt ? new Date(lastSyncAt).getTime() : NaN;
  const verifications = counts.verifications || {};
  return {
    schoolId: school.schoolId,
    name: school.name,
    isActive: school.isActive !== false,
    paymentDetection: classifyPaymentDetection(lastSyncAt, now),
    lastSyncAt,
    lagSeconds: Number.isNaN(syncedAt) ? null : Math.max(0, Math.floor((now - syncedAt) / 1000)),
    hasCursor: Boolean(school.syncCursor),
    ingestStartsAt: school.ingestStartsAt || null,
    pendingVerifications: {
      pending: verifications.pending || 0,
      processing: verifications.processing || 0,
      deadLetter: verifications.dead_letter || 0,
    },
    webhookDeadLetters: counts.webhookDeadLetters || 0,
  };
}

module.exports = { DEFAULT_DELAYED_AFTER_MS, classifyPaymentDetection, buildSchoolOpsRow };
