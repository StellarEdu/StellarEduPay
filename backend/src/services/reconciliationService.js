'use strict';

const mongoose = require('mongoose');
const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const School = require('../models/schoolModel');
const ReconciliationReport = require('../models/reconciliationReportModel');
const ReconciliationCursor = require('../models/reconciliationCursorModel');
const SystemConfig = require('../models/systemConfigModel');
const { checkSchoolConsistency, fetchChainTransactions } = require('./consistencyService');
const cache = require('../cache');
const logger = require('../utils/logger').child('ReconciliationService');

const INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.RECONCILIATION_CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000;
const CHAIN_TOTAL_TTL_SEC = parseInt(process.env.RECONCILIATION_CHAIN_TOTAL_TTL_SEC, 10) || 300;
const chainTotalCacheKey = (schoolId) => `reconciliation:chain_total:${schoolId}`;
const LAST_RUN_KEY = 'reconciliation:lastRunAt';
let _timer = null;

/**
 * Read the persisted last successful run timestamp for the reconciliation job.
 * @returns {Promise<number>} epoch ms, or 0 if never run
 */
async function getLastRunAt() {
  try {
    const doc = await SystemConfig.findOne({ key: LAST_RUN_KEY }).lean();
    if (doc && doc.value) {
      const ts = new Date(doc.value).getTime();
      return Number.isFinite(ts) ? ts : 0;
    }
  } catch (err) {
    logger.error('Failed to read reconciliation lastRunAt', { error: err.message });
  }
  return 0;
}

/**
 * Persist the last successful run timestamp for the reconciliation job.
 * @param {Date} [at]
 */
async function setLastRunAt(at = new Date()) {
  try {
    await SystemConfig.findOneAndUpdate(
      { key: LAST_RUN_KEY },
      { key: LAST_RUN_KEY, value: at.toISOString() },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.error('Failed to persist reconciliation lastRunAt', { error: err.message });
  }
}

/**
 * Reconcile students in batches using cursor-based pagination.
 * Tracks progress so a crash mid-run can resume from the last processed student.
 *
 * @param {string} schoolId - Optional: if set, reconcile only this school
 * @returns {Promise<{checked: number, fixed: number, errors: number, resumed: boolean}>}
 */
async function reconcileAll(schoolId) {
  const query = schoolId ? { schoolId } : {};
  let fixed = 0, errors = 0, checked = 0, resumed = false;

  // Get or create cursor for this reconciliation cycle
  const filter = schoolId ? { schoolId } : { schoolId: { $exists: false } };
  let cursor = await ReconciliationCursor.findOne(filter);

  if (cursor && cursor.status === 'in_progress') {
    resumed = true;
    logger.info('Resuming reconciliation from previous crash', {
      schoolId: schoolId || 'all',
      lastProcessedStudentId: cursor.lastProcessedStudentId,
      processedCount: cursor.processedCount,
    });
  } else {
    cursor = new ReconciliationCursor({
      schoolId: schoolId || undefined,
      cycleStartedAt: new Date(),
      status: 'in_progress',
    });
  }

  try {
    let lastId = cursor.lastProcessedStudentId ? { _id: { $gt: mongoose.Types.ObjectId(cursor.lastProcessedStudentId) } } : {};
    const baseQuery = { ...query, ...lastId };
    let batchChecked = 0;

    while (true) {
      // Fetch next batch of students
      const students = await Student.find(baseQuery)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .lean();

      if (students.length === 0) break;

      for (const s of students) {
        try {
          const [agg] = await Payment.aggregate([
            { $match: { schoolId: s.schoolId, studentId: s.studentId, status: 'SUCCESS', deletedAt: null } },
            { $group: { _id: null, computedTotal: { $sum: '$amount' } } },
          ]);
          const paymentTotal = agg?.computedTotal ?? 0;
          const creditAdjustments = s.creditAdjustments || 0;
          const computed = parseFloat((paymentTotal + creditAdjustments).toFixed(7));

          if (Math.abs(computed - (s.totalPaid || 0)) > 0.0000001) {
            logger.warn('Reconciliation mismatch — correcting', {
              schoolId: s.schoolId,
              studentId: s.studentId,
              diff: computed - (s.totalPaid || 0),
            });
            await Student.findOneAndUpdate(
              { schoolId: s.schoolId, studentId: s.studentId },
              {
                totalPaid: computed,
                remainingBalance: Math.max(0, s.feeAmount - computed),
                feePaid: computed >= s.feeAmount,
              },
            );
            fixed++;
          }

          checked++;
          batchChecked++;
          cursor.lastProcessedStudentId = s._id.toString();
        } catch (err) {
          errors++;
          cursor.failedCount++;
          logger.error('Reconciliation error', {
            studentId: s.studentId,
            schoolId: s.schoolId,
            error: err.message,
          });
        }
      }

      // Update cursor after each batch
      cursor.processedCount += batchChecked;
      cursor.lastUpdatedAt = new Date();
      await ReconciliationCursor.findByIdAndUpdate(cursor._id, {
        processedCount: cursor.processedCount,
        failedCount: cursor.failedCount,
        lastProcessedStudentId: cursor.lastProcessedStudentId,
        lastUpdatedAt: cursor.lastUpdatedAt,
      });

      batchChecked = 0;

      // Continue to next batch
      if (students.length < BATCH_SIZE) break;

      // Move query to next batch
      baseQuery._id = { $gt: mongoose.Types.ObjectId(students[students.length - 1]._id) };
    }

    // Mark cursor as completed
    cursor.status = 'completed';
    await ReconciliationCursor.findByIdAndUpdate(cursor._id, {
      status: 'completed',
      lastUpdatedAt: new Date(),
    });

    logger.info('Reconciliation complete', {
      schoolId: schoolId || 'all',
      checked,
      fixed,
      errors,
      resumed,
      batchSize: BATCH_SIZE,
    });

    return { checked, fixed, errors, resumed };
  } catch (err) {
    cursor.status = 'failed';
    await ReconciliationCursor.findByIdAndUpdate(cursor._id, {
      status: 'failed',
      lastUpdatedAt: new Date(),
    });
    logger.error('Reconciliation failed', {
      schoolId: schoolId || 'all',
      error: err.message,
      processedCount: cursor.processedCount,
      resumable: true,
    });
    throw err;
  }
}

/**
 * Run the reconciliation job if it is due (now - lastRunAt >= INTERVAL_MS).
 * Persists lastRunAt on success so restarts and leader changes do not reset
 * the schedule. Exposes job_last_success_timestamp_seconds for alerting.
 *
 * @returns {Promise<boolean>} true if the job ran
 */
async function runReconciliationIfDue() {
  const lastRunAt = await getLastRunAt();
  const now = Date.now();
  if (lastRunAt && now - lastRunAt < INTERVAL_MS) {
    return false;
  }
  try {
    await reconcileAll();
    const completedAt = new Date();
    await setLastRunAt(completedAt);
    if (typeof metrics !== 'undefined' && metrics && typeof metrics.setJobLastSuccess === 'function') {
      metrics.setJobLastSuccess('reconciliation', completedAt.getTime() / 1000);
    }
    return true;
  } catch (err) {
    logger.error('Scheduled reconciliation failed', { error: err.message });
    return false;
  }
}

function startReconciliationScheduler() {
  if (_timer) return;
  // Run immediately on start (catch-up after restart / leader change), then
  // poll on a short interval so a due job is picked up promptly.
  runReconciliationIfDue().catch((err) => logger.error('Scheduler initial run error', { error: err.message }));
  _timer = setInterval(() => {
    runReconciliationIfDue().catch((err) => logger.error('Scheduler error', { error: err.message }));
  }, CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

function stopReconciliationScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function generateReconciliationReport(schoolId) {
  try {
    const school = await School.findOne({ schoolId }).lean();
    if (!school) {
      logger.warn('School not found for reconciliation report', { schoolId });
      return null;
    }

    const dbPayments = await Payment.find({ schoolId, status: 'SUCCESS', deletedAt: null }).lean();
    const dbTotalCredited = dbPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // The chain total is expensive to compute (paginated Horizon fetch + a
    // per-tx operations() call) and doesn't change meaningfully between
    // repeated report requests, so cache it briefly per school.
    const cacheKey = chainTotalCacheKey(schoolId);
    let cached = cache.get(cacheKey);
    let chainTotalReceived;
    let chainTxCount;
    if (cached) {
      ({ chainTotalReceived, chainTxCount } = cached);
    } else {
      const chainTxs = await fetchChainTransactions(school.stellarAddress);
      chainTotalReceived = 0;
      for (const tx of chainTxs) {
        const ops = await tx.operations();
        const payOp = ops.records.find(
          (op) => op.type === 'payment' && op.to === school.stellarAddress
        );
        if (payOp) {
          chainTotalReceived += parseFloat(parseFloat(payOp.amount).toFixed(7));
        }
      }
      chainTxCount = chainTxs.length;
      cache.set(cacheKey, { chainTotalReceived, chainTxCount }, CHAIN_TOTAL_TTL_SEC);
    }

    const drift = Math.abs(chainTotalReceived - dbTotalCredited);
    const driftPercentage = dbTotalCredited > 0 ? (drift / dbTotalCredited) * 100 : 0;
    const threshold = parseFloat(process.env.RECONCILIATION_DRIFT_THRESHOLD || '0.5');
    const alertRaised = driftPercentage > threshold;

    const report = await ReconciliationReport.create({
      schoolId,
      reportedAt: new Date(),
      dbTotalCredited,
      chainTotalReceived,
      drift,
      driftPercentage,
      threshold,
      alertRaised,
      paymentCount: dbPayments.length,
      chainTxCount,
      details: {
        schoolName: school.name,
        checkTime: new Date().toISOString(),
      },
    });

    if (alertRaised) {
      logger.warn('Reconciliation drift alert', {
        schoolId,
        drift,
        driftPercentage,
        dbTotal: dbTotalCredited,
        chainTotal: chainTotalReceived,
      });
    }

    return report;
  } catch (err) {
    logger.error('Failed to generate reconciliation report', {
      schoolId,
      error: err.message,
    });
    throw err;
  }
}

module.exports = {
  reconcileAll,
  runReconciliationIfDue,
  startReconciliationScheduler,
  stopReconciliationScheduler,
  generateReconciliationReport,
  getLastRunAt,
  setLastRunAt,
};
