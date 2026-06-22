'use strict';

const Payment = require('../models/paymentModel');
const { enqueueTransaction } = require('../queue/transactionQueue');
const { resolveCorrelationId } = require('../utils/correlationId');
const logger = require('../utils/logger').child('StuckPaymentReconciliation');

const STUCK_PAYMENT_THRESHOLD_MS = parseInt(process.env.STUCK_PAYMENT_THRESHOLD_MS, 10) || 5 * 60 * 1000;

async function findStuckPayments() {
  return Payment.find({ status: 'SUBMITTED', submittedAt: { $lt: new Date(Date.now() - STUCK_PAYMENT_THRESHOLD_MS) } }).lean();
}

async function reconcileStuckPayments() {
  const stuck = await findStuckPayments();
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

module.exports = { reconcileStuckPayments, findStuckPayments, STUCK_PAYMENT_THRESHOLD_MS };
