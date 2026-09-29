'use strict';

// #881 — Pre-aggregated daily/monthly rollups so dashboard reads don't
// scan the raw payments collection. Two update modes:
//
//   incrementPaymentMetrics(payment) — called on each confirmed payment;
//     uses $inc so it's O(1) regardless of history size.
//
//   reconcileMetrics(schoolId, period) — rebuilds a single period from raw
//     data; run on a schedule to self-heal any drift (e.g. after a dispute).

const Payment = require('../models/paymentModel');
const { DailyMetrics, MonthlyMetrics } = require('../models/metricsModel');
const logger = require('../utils/logger');

/** Format a Date as 'YYYY-MM-DD' (UTC). */
function _dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Format a Date as 'YYYY-MM' (UTC). */
function _monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

/**
 * Increment rollups for a single confirmed payment.
 * Called from the payment.saved event subscriber — O(1) DB writes.
 */
async function incrementPaymentMetrics(payment) {
  if (payment.status !== 'SUCCESS') return;

  const confirmedAt = payment.confirmedAt || new Date();
  const day   = _dayKey(confirmedAt);
  const month = _monthKey(confirmedAt);

  const inc = {
    paymentCount:   1,
    totalAmount:    payment.amount || 0,
    totalFiatAmount: payment.fiatSnapshot?.fiatAmount || 0,
    validCount:     payment.feeValidationStatus === 'valid'      ? 1 : 0,
    overpaidCount:  payment.feeValidationStatus === 'overpaid'   ? 1 : 0,
    underpaidCount: payment.feeValidationStatus === 'underpaid'  ? 1 : 0,
  };

  const setOnInsert = {
    schoolId: payment.schoolId,
    fiatCurrency: payment.fiatSnapshot?.fiatCurrency || null,
  };

  // Unique-student count cannot be incremented blindly; leave for reconciliation.
  // All other fields are safe to $inc.
  const opts = { upsert: true, new: false };
  await Promise.all([
    DailyMetrics.findOneAndUpdate(
      { schoolId: payment.schoolId, period: day },
      { $inc: inc, $setOnInsert: setOnInsert },
      opts,
    ),
    MonthlyMetrics.findOneAndUpdate(
      { schoolId: payment.schoolId, period: month },
      { $inc: inc, $setOnInsert: setOnInsert },
      opts,
    ),
  ]);
}

/**
 * Rebuild rollups for all periods within [startDate, endDate] (YYYY-MM-DD strings)
 * for a given school from the raw payments collection.
 * Used by the scheduled reconciliation job to self-heal drift.
 */
async function reconcileMetrics(schoolId, { startDate, endDate } = {}) {
  const match = { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null };
  if (startDate || endDate) {
    match.confirmedAt = {};
    if (startDate) match.confirmedAt.$gte = new Date(startDate + 'T00:00:00.000Z');
    if (endDate)   match.confirmedAt.$lte = new Date(endDate   + 'T23:59:59.999Z');
  }

  // Aggregate daily rows from raw payments
  const dailyRows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$confirmedAt', timezone: 'UTC' } },
        paymentCount:   { $sum: 1 },
        totalAmount:    { $sum: '$amount' },
        totalFiatAmount:{ $sum: { $ifNull: ['$fiatSnapshot.fiatAmount', 0] } },
        fiatCurrency:   { $first: '$fiatSnapshot.fiatCurrency' },
        validCount:     { $sum: { $cond: [{ $eq: ['$feeValidationStatus', 'valid'] }, 1, 0] } },
        overpaidCount:  { $sum: { $cond: [{ $eq: ['$feeValidationStatus', 'overpaid'] }, 1, 0] } },
        underpaidCount: { $sum: { $cond: [{ $eq: ['$feeValidationStatus', 'underpaid'] }, 1, 0] } },
        uniqueStudents: { $addToSet: '$studentId' },
      },
    },
  ]);

  const now = new Date();
  const dailyOps = dailyRows.map(r => ({
    updateOne: {
      filter: { schoolId, period: r._id },
      update: {
        $set: {
          schoolId,
          period:          r._id,
          paymentCount:    r.paymentCount,
          totalAmount:     parseFloat(r.totalAmount.toFixed(7)),
          totalFiatAmount: parseFloat(r.totalFiatAmount.toFixed(2)),
          fiatCurrency:    r.fiatCurrency || null,
          validCount:      r.validCount,
          overpaidCount:   r.overpaidCount,
          underpaidCount:  r.underpaidCount,
          uniqueStudents:  r.uniqueStudents.length,
          reconciledAt:    now,
        },
      },
      upsert: true,
    },
  }));

  if (dailyOps.length) await DailyMetrics.bulkWrite(dailyOps, { ordered: false });

  // Roll daily → monthly
  const monthMap = {};
  for (const r of dailyRows) {
    const m = r._id.slice(0, 7); // 'YYYY-MM'
    if (!monthMap[m]) {
      monthMap[m] = { paymentCount: 0, totalAmount: 0, totalFiatAmount: 0, validCount: 0, overpaidCount: 0, underpaidCount: 0, students: new Set(), fiatCurrency: r.fiatCurrency };
    }
    const mm = monthMap[m];
    mm.paymentCount   += r.paymentCount;
    mm.totalAmount    += r.totalAmount;
    mm.totalFiatAmount+= r.totalFiatAmount;
    mm.validCount     += r.validCount;
    mm.overpaidCount  += r.overpaidCount;
    mm.underpaidCount += r.underpaidCount;
    r.uniqueStudents.forEach(s => mm.students.add(s));
  }

  const monthlyOps = Object.entries(monthMap).map(([period, m]) => ({
    updateOne: {
      filter: { schoolId, period },
      update: {
        $set: {
          schoolId,
          period,
          paymentCount:    m.paymentCount,
          totalAmount:     parseFloat(m.totalAmount.toFixed(7)),
          totalFiatAmount: parseFloat(m.totalFiatAmount.toFixed(2)),
          fiatCurrency:    m.fiatCurrency || null,
          validCount:      m.validCount,
          overpaidCount:   m.overpaidCount,
          underpaidCount:  m.underpaidCount,
          uniqueStudents:  m.students.size,
          reconciledAt:    now,
        },
      },
      upsert: true,
    },
  }));

  if (monthlyOps.length) await MonthlyMetrics.bulkWrite(monthlyOps, { ordered: false });

  logger.info('METRICS_RECONCILED', { schoolId, dailyPeriods: dailyOps.length, monthlyPeriods: monthlyOps.length });
  return { dailyPeriods: dailyOps.length, monthlyPeriods: monthlyOps.length };
}

// ── Scheduled full reconciliation ─────────────────────────────────────────────
// #1607 — A plain setInterval(24h) never fires when the process restarts or
// leadership moves more often than the interval. Persist the last successful
// run per job and, on start plus a short check interval, run the job when
// `now - lastRunAt >= interval`. This guarantees the daily job runs once per
// day regardless of restarts/leader changes, and exposes
// job_last_success_timestamp_seconds{job} for overdue alerting.

const RECONCILE_INTERVAL_MS = parseInt(process.env.METRICS_RECONCILE_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
const CHECK_INTERVAL_MS = parseInt(process.env.SCHEDULER_CHECK_INTERVAL_MS || String(5 * 60 * 1000), 10);
const JOB_NAME = 'metrics_rollup_reconcile';

let _timer = null;
let _running = false;

/**
 * Persist the last successful run timestamp for a scheduled job.
 * Uses SystemConfig when available; falls back to an in-memory value so the
 * scheduler still works in environments without the model.
 */
const _memoryLastRun = {};

async function _getLastRunAt(jobName) {
  try {
    const SystemConfig = require('../models/systemConfigModel');
    const doc = await SystemConfig.findOne({ key: `scheduler:${jobName}:lastRunAt` }).lean();
    if (doc && doc.value) return new Date(doc.value);
  } catch (err) {
    logger.warn('SCHEDULER_LAST_RUN_READ_FAILED', { job: jobName, error: err.message });
  }
  return _memoryLastRun[jobName] || null;
}

async function _setLastRunAt(jobName, when) {
  _memoryLastRun[jobName] = when;
  try {
    const SystemConfig = require('../models/systemConfigModel');
    await SystemConfig.findOneAndUpdate(
      { key: `scheduler:${jobName}:lastRunAt` },
      { $set: { key: `scheduler:${jobName}:lastRunAt`, value: when.toISOString() } },
      { upsert: true },
    );
  } catch (err) {
    logger.warn('SCHEDULER_LAST_RUN_WRITE_FAILED', { job: jobName, error: err.message });
  }
}

/**
 * Expose job_last_success_timestamp_seconds{job} for overdue alerting.
 * Best-effort: uses the metrics registry if present, otherwise logs.
 */
function _recordJobSuccess(jobName, when) {
  const seconds = Math.floor(when.getTime() / 1000);
  try {
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.setGauge === 'function') {
      metrics.setGauge('job_last_success_timestamp_seconds', seconds, { job: jobName });
      return;
    }
    if (metrics && metrics.jobLastSuccessTimestampSeconds && typeof metrics.jobLastSuccessTimestampSeconds.set === 'function') {
      metrics.jobLastSuccessTimestampSeconds.set({ job: jobName }, seconds);
      return;
    }
  } catch (err) {
    // metrics module optional — fall through to log
  }
  logger.info('JOB_LAST_SUCCESS_TIMESTAMP_SECONDS', { job: jobName, value: seconds });
}

async function _runScheduledReconciliation() {
  const School = require('../models/schoolModel');
  const schools = await School.find({ isActive: true }, 'schoolId').lean();
  const endDate   = _dayKey(new Date());
  const startDate = _dayKey(new Date(Date.now() - 32 * 86400000));
  for (const school of schools) {
    try {
      await reconcileMetrics(school.schoolId, { startDate, endDate });
    } catch (err) {
      logger.error('METRICS_RECONCILE_FAILED', { schoolId: school.schoolId, error: err.message });
    }
  }
}

/**
 * Run the job if it is due (now - lastRunAt >= interval). Persists the last
 * successful run and records the success metric. Safe to call on start and
 * from the short check interval; guarded against overlapping runs.
 */
async function _runIfDue() {
  if (_running) return;
  _running = true;
  try {
    const lastRunAt = await _getLastRunAt(JOB_NAME);
    const now = Date.now();
    if (lastRunAt && now - lastRunAt.getTime() < RECONCILE_INTERVAL_MS) return;

    await _runScheduledReconciliation();

    const completedAt = new Date();
    await _setLastRunAt(JOB_NAME, completedAt);
    _recordJobSuccess(JOB_NAME, completedAt);
  } catch (err) {
    logger.error('METRICS_RECONCILE_SCHEDULER_FAILED', { error: err.message });
  } finally {
    _running = false;
  }
}

function startMetricsRollupScheduler() {
  if (_timer) return;
  // Run immediately on start (catch-up after restart/leader change), then
  // check frequently so a missed interval is picked up promptly.
  _runIfDue();
  _timer = setInterval(_runIfDue, CHECK_INTERVAL_MS);
  _timer.unref();
}

function stopMetricsRollupScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  incrementPaymentMetrics,
  reconcileMetrics,
  startMetricsRollupScheduler,
  stopMetricsRollupScheduler,
};
