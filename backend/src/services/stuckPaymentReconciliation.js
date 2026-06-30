'use strict';

const Payment = require('../models/paymentModel');
const { enqueueTransaction } = require('../queue/transactionQueue');
const { resolveCorrelationId } = require('../utils/correlationId');
const logger = require('../utils/logger').child('StuckPaymentReconciliation');

const STUCK_PAYMENT_THRESHOLD_MS = parseInt(process.env.STUCK_PAYMENT_THRESHOLD_MS, 10) || 5 * 60 * 1000;
const STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS = parseInt(process.env.STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS, 10) || 10 * 60 * 1000;
const STUCK_PAYMENT_RECONCILIATION_MAX_BATCH = parseInt(process.env.STUCK_PAYMENT_RECONCILIATION_MAX_BATCH, 10) || 100;

let _timer = null;

async function findStuckPayments(limit = STUCK_PAYMENT_RECONCILIATION_MAX_BATCH) {
  return Payment.find({
    status: 'SUBMITTED',
    submittedAt: { $lt: new Date(Date.now() - STUCK_PAYMENT_THRESHOLD_MS) },
    deletedAt: null,
  })
    .sort({ submittedAt: 1 })
    .limit(limit)
    .lean();
}

async function reconcileStuckPayments(limit = STUCK_PAYMENT_RECONCILIATION_MAX_BATCH) {
  const stuck = await findStuckPayments(limit);
  if (!stuck.length) return 0;
  logger.info(`Found ${stuck.length} stuck payments — re-queuing`);
  let requeued = 0;
  for (const p of stuck) {
    const correlationId = resolveCorrelationId(p.correlationId, p.txHash);
    try {
      await enqueueTransaction(p.txHash, { schoolId: p.schoolId, studentId: p.studentId, correlationId });
      requeued++;
    } catch (err) {
      logger.error('Failed to re-queue stuck payment', { txHash: p.txHash, correlationId, error: err.message });
    }
  }
  logger.info(`Reconciliation complete — re-queued ${requeued}/${stuck.length}`);
  return requeued;
}

async function _runScheduledReconciliation() {
  try {
    const requeued = await reconcileStuckPayments();
    logger.info('Scheduled stuck payment reconciliation complete', { requeued });
  } catch (err) {
    logger.error('Scheduled stuck payment reconciliation failed', { error: err.message });
  }
}

function startStuckPaymentReconciliationScheduler() {
  if (_timer) return;
  _timer = setInterval(_runScheduledReconciliation, STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('Stuck payment reconciliation scheduler started', {
    intervalMs: STUCK_PAYMENT_RECONCILIATION_INTERVAL_MS,
    maxBatch: STUCK_PAYMENT_RECONCILIATION_MAX_BATCH,
    ageThresholdMs: STUCK_PAYMENT_THRESHOLD_MS,
  });
}

function stopStuckPaymentReconciliationScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = {
  reconcileStuckPayments,
  findStuckPayments,
  STUCK_PAYMENT_THRESHOLD_MS,
  startStuckPaymentReconciliationScheduler,
  stopStuckPaymentReconciliationScheduler,
};
