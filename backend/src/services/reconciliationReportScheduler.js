'use strict';

const { generateAllReconciliationReports } = require('./reconciliationService');
const logger = require('../utils/logger').child('ReconciliationReportScheduler');

const INTERVAL_MS = parseInt(process.env.RECONCILIATION_REPORT_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.RECONCILIATION_REPORT_CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000;
const JOB_NAME = 'reconciliation_report';

let _timer = null;
let _lastRunAt = null;
let _running = false;

function isDue(now) {
  if (_lastRunAt === null) return true;
  return now - _lastRunAt >= INTERVAL_MS;
}

async function runIfDue() {
  if (_running) return;
  const now = Date.now();
  if (!isDue(now)) return;
  _running = true;
  try {
    await generateAllReconciliationReports();
    _lastRunAt = Date.now();
    logger.info('Reconciliation report job completed', { lastRunAt: new Date(_lastRunAt).toISOString() });
  } catch (err) {
    logger.error('Reconciliation report scheduler error', { error: err.message });
  } finally {
    _running = false;
  }
}

function startReconciliationReportScheduler() {
  if (_timer) return;
  // Run immediately on start (and on leader change) if the job is overdue,
  // so restarts more frequent than the interval no longer skip the daily run.
  runIfDue();
  _timer = setInterval(runIfDue, CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('Reconciliation report scheduler started', { intervalMs: INTERVAL_MS, checkIntervalMs: CHECK_INTERVAL_MS });
}

function stopReconciliationReportScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('Reconciliation report scheduler stopped');
  }
}

function getReconciliationReportLastRunAt() {
  return _lastRunAt;
}

module.exports = {
  startReconciliationReportScheduler,
  stopReconciliationReportScheduler,
  getReconciliationReportLastRunAt,
  JOB_NAME,
};
