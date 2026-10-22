'use strict';

/**
 * Super-admin operations overview (#1817).
 *
 * One request answers "is payment detection working for each school right
 * now?" by combining poll timestamps, cursor state, verification backlog and
 * webhook dead-letters. Each source is read with one grouped query, not one
 * query per school.
 */

const School = require('../models/schoolModel');
const SystemConfig = require('../models/systemConfigModel');
const PendingVerification = require('../models/pendingVerificationModel');
const WebhookRetry = require('../models/webhookRetryModel');
const { buildSchoolOpsRow } = require('../utils/opsStatus');

const LAST_SYNC_PREFIX = 'lastSyncAt:';

async function getOpsOverview(req, res, next) {
  try {
    const now = Date.now();
    const [schools, syncConfigs, verificationGroups, dlqGroups] = await Promise.all([
      School.find({}).select('schoolId name isActive syncCursor ingestStartsAt').lean(),
      SystemConfig.find({ key: { $regex: `^${LAST_SYNC_PREFIX}` } }).lean(),
      PendingVerification.aggregate([
        { $match: { status: { $in: ['pending', 'processing', 'dead_letter'] } } },
        { $group: { _id: { schoolId: '$schoolId', status: '$status' }, count: { $sum: 1 } } },
      ]),
      WebhookRetry.aggregate([
        { $match: { status: 'failed' } },
        { $group: { _id: '$schoolId', count: { $sum: 1 } } },
      ]),
    ]);

    const lastSyncBySchool = new Map(
      syncConfigs.map(doc => [doc.key.slice(LAST_SYNC_PREFIX.length), doc.value]),
    );

    const verificationsBySchool = new Map();
    for (const group of verificationGroups) {
      const { schoolId, status } = group._id;
      if (!verificationsBySchool.has(schoolId)) verificationsBySchool.set(schoolId, {});
      verificationsBySchool.get(schoolId)[status] = group.count;
    }

    const dlqBySchool = new Map(dlqGroups.map(group => [group._id, group.count]));

    const rows = schools.map(school => buildSchoolOpsRow(
      school,
      {
        lastSyncAt: lastSyncBySchool.get(school.schoolId) || null,
        verifications: verificationsBySchool.get(school.schoolId) || {},
        webhookDeadLetters: dlqBySchool.get(school.schoolId) || 0,
      },
      now,
    ));

    const summary = { operational: 0, delayed: 0, never_synced: 0 };
    for (const row of rows) summary[row.paymentDetection] += 1;

    return res.status(200).json({
      generatedAt: new Date(now).toISOString(),
      summary,
      schools: rows,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getOpsOverview };
