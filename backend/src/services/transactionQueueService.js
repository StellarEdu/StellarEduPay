'use strict';

/**
 * Transaction Queue Service
 *
 * Bridges the BullMQ transaction processing queue with the Stellar verification
 * logic. Starts the worker on app boot, calls recoverPendingJobs() to re-enqueue
 * any jobs that survived a restart in MongoDB, and marks PendingVerification
 * documents resolved/dead after each job completes.
 */

const {
  startTransactionWorker,
  recoverPendingJobs,
  markResolved,
  markDead,
} = require('../queue/transactionQueue');
const { verifyTransaction, recordPayment } = require('./stellarService');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const PendingVerification = require('../models/pendingVerificationModel');
const logger = require('../utils/logger');
const { resolveCorrelationId } = require('../utils/correlationId');
const { captureFiatSnapshot } = require('./currencyConversionService');

const PERMANENT_FAIL_CODES = [
  'TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION',
  'UNSUPPORTED_ASSET', 'AMOUNT_TOO_LOW', 'AMOUNT_TOO_HIGH', 'UNDERPAID',
];

/**
 * Core processor executed by the BullMQ worker for each job.
 */
async function processTransactionJob(job) {
  const { txHash, schoolId, school } = job.data;
  const correlationId = resolveCorrelationId(job.data.correlationId, txHash);

  // Mark as processing in MongoDB so restart recovery knows it was in-flight
  await PendingVerification.findOneAndUpdate(
    { txHash, status: { $in: ['pending', 'processing'] } },
    { status: 'processing', lastAttemptAt: new Date(), $inc: { attempts: 1 } }
  );

  // Skip if already recorded
  const existing = await Payment.findOne({ txHash, schoolId, deletedAt: null });
  if (existing) {
    logger.info('[TxQueueService] Transaction already processed, skipping', { txHash, correlationId });
    await markResolved(txHash);
    return { skipped: true, txHash };
  }

  const result = await verifyTransaction(txHash, school.stellarAddress);
  if (!result) throw Object.assign(new Error('No valid payment found'), { code: 'NOT_FOUND' });

  // Reject underpaid
  if (result.feeValidation.status === 'underpaid') {
    const err = new Error(result.feeValidation.message);
    err.code = 'UNDERPAID';
    throw err;
  }

  // Validate intent expiry
  const intent = await PaymentIntent.findOne({ memo: result.memo, schoolId });
  if (intent?.expiresAt && intent.expiresAt < new Date()) {
    await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'expired' });
    throw Object.assign(new Error('Payment intent has expired'), { code: 'INTENT_EXPIRED' });
  }

  const studentObj = await Student.findOne({ studentId: result.studentId || result.memo });
  if (!studentObj) throw Object.assign(new Error('Associated student not found'), { code: 'NOT_FOUND' });

  const now = new Date();
  // #883 — capture fiat rate at confirmation time (best-effort)
  const fiatSnapshot = await captureFiatSnapshot(
    result.amount,
    result.assetCode || 'XLM',
    process.env.DEFAULT_FIAT_CURRENCY || 'USD',
  );
  await recordPayment({
    schoolId,
    studentId:           result.studentId || result.memo,
    txHash:              result.hash,
    correlationId,
    amount:              result.amount,
    feeAmount:           result.feeAmount,
    feeValidationStatus: result.feeValidation.status,
    excessAmount:        result.feeValidation.excessAmount,
    networkFee:          result.networkFee,
    status:              'SUCCESS',
    memo:                result.memo,
    senderAddress:       result.senderAddress || null,
    ledgerSequence:      result.ledger || null,
    confirmationStatus:  'confirmed',
    confirmedAt:         result.date ? new Date(result.date) : now,
    verifiedAt:          now,
    fiatSnapshot,
  });

  // Mark durable record resolved
  await markResolved(txHash);

  logger.info('[TxQueueService] Transaction processed successfully', { txHash, correlationId });
  return { success: true, txHash, correlationId, studentId: result.studentId || result.memo };
}

/**
 * Processor wrapper: permanent errors are not retried; mark dead in MongoDB.
 */
async function jobProcessor(job) {
  const correlationId = resolveCorrelationId(job.data.correlationId, job.data.txHash);
  try {
    return await processTransactionJob(job);
  } catch (err) {
    if (PERMANENT_FAIL_CODES.includes(err.code)) {
      // Audit trail
      await Payment.create({
        schoolId:  job.data.schoolId,
        studentId: 'unknown',
        txHash:    job.data.txHash,
        correlationId,
        amount:    0,
        status:    'FAILED',
        feeValidationStatus: 'unknown',
      }).catch(() => {});

      // Mark durable record as dead_letter
      await markDead(job.data.txHash, err);

      err.message = `[permanent] ${err.message}`;
    } else {
      // Transient failure — update lastError but keep status=processing so
      // BullMQ retries; if all retries exhaust, markDead will be called below.
      await PendingVerification.findOneAndUpdate(
        { txHash: job.data.txHash },
        { lastError: err.message }
      );
    }
    throw err;
  }
}

let worker = null;

async function startWorker() {
  if (worker) return worker;
  worker = startTransactionWorker(jobProcessor);

  // Re-enqueue any jobs that survived a restart in MongoDB
  try {
    await recoverPendingJobs();
  } catch (err) {
    logger.error('[TxQueueService] Startup recovery failed', { error: err.message });
  }

  return worker;
}

async function stopWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

module.exports = { startWorker, stopWorker };
