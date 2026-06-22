'use strict';

/**
 * Transaction Processing Queue
 *
 * Durability guarantee: every job is persisted to MongoDB (PendingVerification)
 * BEFORE being handed to Redis/BullMQ.  If Redis is unavailable the job is still
 * safe in MongoDB and will be recovered on the next startup via recoverPendingJobs().
 *
 * Flow:
 *   enqueueTransaction(txHash, ctx)
 *     1. Upsert a PendingVerification document (status=pending, idempotent on txHash)
 *     2. Try to add the job to BullMQ (Redis).  If Redis is down, log a warning —
 *        the document stays in MongoDB and will be re-queued on startup.
 *
 *   recoverPendingJobs()
 *     Called once at startup.  Finds all PendingVerification docs with
 *     status=pending|processing and re-enqueues them into BullMQ so they are
 *     not silently dropped after a crash or restart.
 *
 *   markResolved(txHash) / markDead(txHash, error)
 *     Called by the worker after a job succeeds or permanently fails.
 */

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const PendingVerification = require('../models/pendingVerificationModel');
const logger = require('../utils/logger');
const { resolveCorrelationId } = require('../utils/correlationId');

const QUEUE_NAME = 'transaction-processing';

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // required by BullMQ
  // Do not crash the process on Redis errors — we have MongoDB as fallback
  lazyConnect: true,
  enableOfflineQueue: false,
};

// Shared Redis connection for the queue
const connection = new Redis(redisConfig);
connection.on('error', (err) =>
  logger.error('[TransactionQueue] Redis error', { error: err.message })
);

let transactionQueue = null;
try {
  transactionQueue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: false,
    },
  });
} catch (err) {
  logger.error('[TransactionQueue] Failed to create BullMQ queue', { error: err.message });
}

// ── MongoDB durability helpers ────────────────────────────────────────────────

/**
 * Persist a job to MongoDB before enqueuing to Redis.
 * Uses upsert so duplicate calls for the same txHash are safe.
 */
async function persistJob(txHash, context = {}) {
  const schoolId = context.schoolId || 'unknown';
  await PendingVerification.findOneAndUpdate(
    { txHash, schoolId },
    {
      $setOnInsert: {
        txHash,
        schoolId,
        studentId: context.studentId || null,
        correlationId: resolveCorrelationId(context.correlationId, txHash),
        status: 'pending',
        attempts: 0,
        nextRetryAt: new Date(),
      },
    },
    { upsert: true, new: false }
  );
}

/**
 * Mark a PendingVerification document as resolved (job completed successfully).
 * Bypass is required: the worker has txHash but not schoolId; txHash is globally unique.
 */
async function markResolved(txHash) {
  await PendingVerification.findOneAndUpdate(
    { txHash },
    { status: 'resolved', resolvedAt: new Date() },
    { _bypassTenantScope: true }
  );
}

/**
 * Mark a PendingVerification document as dead_letter (permanent failure).
 * Bypass is required: the worker has txHash but not schoolId; txHash is globally unique.
 */
async function markDead(txHash, error) {
  await PendingVerification.findOneAndUpdate(
    { txHash },
    {
      status: 'dead_letter',
      lastError: error?.message || String(error),
    },
    { _bypassTenantScope: true }
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue a transaction for async processing.
 *
 * Durability: the job is written to MongoDB first.  The BullMQ enqueue is
 * best-effort — if Redis is down the job survives in MongoDB and will be
 * recovered on the next startup.
 *
 * @param {string} txHash
 * @param {Object} context  - { schoolId, school, studentId }
 * @returns {Promise<Job|null>}
 */
async function enqueueTransaction(txHash, context = {}) {
  const correlationId = resolveCorrelationId(context.correlationId, txHash);
  const enrichedContext = { ...context, correlationId };

  // 1. Persist to MongoDB (durable, idempotent)
  await persistJob(txHash, enrichedContext);

  // 2. Enqueue to BullMQ (best-effort)
  if (!transactionQueue) {
    logger.warn('[TransactionQueue] BullMQ unavailable — job persisted to MongoDB only', { txHash, correlationId });
    return null;
  }

  try {
    const job = await transactionQueue.add(
      'verify-transaction',
      { txHash, ...enrichedContext },
      { jobId: txHash } // deduplicate by txHash
    );
    logger.info('[TransactionQueue] Enqueued transaction', { txHash, correlationId, jobId: job.id });
    return job;
  } catch (err) {
    logger.warn('[TransactionQueue] Redis enqueue failed — job persisted to MongoDB only', {
      txHash,
      correlationId,
      error: err.message,
    });
    return null;
  }
}

/**
 * On startup: find all PendingVerification docs that were not resolved before
 * the last restart and re-enqueue them into BullMQ.
 *
 * This covers two scenarios:
 *   a) Server crashed while jobs were in-flight (status=processing)
 *   b) Redis was down when jobs were originally submitted (status=pending, never queued)
 */
async function recoverPendingJobs() {
  if (!transactionQueue) {
    logger.warn('[TransactionQueue] Skipping recovery — BullMQ unavailable');
    return 0;
  }

  // Startup recovery: intentionally spans all schools to re-queue unfinished jobs.
  const unresolved = await PendingVerification.find({
    status: { $in: ['pending', 'processing'] },
  }).bypassTenantScope().lean();

  if (!unresolved.length) {
    logger.info('[TransactionQueue] No pending jobs to recover');
    return 0;
  }

  let recovered = 0;
  for (const doc of unresolved) {
    const correlationId = resolveCorrelationId(doc.correlationId, doc.txHash);
    try {
      // Reset processing → pending so the worker picks it up fresh.
      // schoolId is known from the fetched doc, so no bypass needed here.
      await PendingVerification.findOneAndUpdate(
        { txHash: doc.txHash, schoolId: doc.schoolId, status: 'processing' },
        { status: 'pending' }
      );

      await transactionQueue.add(
        'verify-transaction',
        { txHash: doc.txHash, schoolId: doc.schoolId, studentId: doc.studentId, correlationId },
        { jobId: doc.txHash }
      );
      recovered++;
    } catch (err) {
      logger.error('[TransactionQueue] Failed to recover job', {
        txHash: doc.txHash,
        correlationId,
        error: err.message,
      });
    }
  }

  logger.info('[TransactionQueue] Recovery complete', { recovered, total: unresolved.length });
  return recovered;
}

/**
 * Get the current status of a queued transaction job.
 * @param {string} txHash
 */
async function getJobStatus(txHash) {
  if (!transactionQueue) return null;
  const job = await transactionQueue.getJob(txHash);
  if (!job) return null;

  const state = await job.getState();
  return {
    jobId: job.id,
    txHash: job.data.txHash,
    correlationId: job.data.correlationId || null,
    state,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason || null,
    result: job.returnvalue || null,
    createdAt: new Date(job.timestamp).toISOString(),
    processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

/**
 * Start the BullMQ worker that processes queued transactions.
 * The processor function is injected so this module stays decoupled
 * from the payment controller / stellar service.
 *
 * @param {Function} processor  async (job) => result
 */
function startTransactionWorker(processor) {
  const worker = new Worker(QUEUE_NAME, processor, {
    connection: new Redis(redisConfig),
    concurrency: parseInt(process.env.TX_QUEUE_CONCURRENCY, 10) || 5,
  });

  worker.on('completed', (job) =>
    logger.info('[TransactionQueue] Job completed', {
      jobId: job.id,
      txHash: job.data.txHash,
      correlationId: job.data.correlationId || null,
    })
  );
  worker.on('failed', (job, err) =>
    logger.error('[TransactionQueue] Job failed', {
      jobId: job?.id,
      txHash: job?.data?.txHash,
      correlationId: job?.data?.correlationId || null,
      error: err.message,
    })
  );

  logger.info('[TransactionQueue] Worker started', {
    concurrency: parseInt(process.env.TX_QUEUE_CONCURRENCY, 10) || 5,
  });

  return worker;
}

async function closeQueue() {
  try {
    if (transactionQueue) {
      await transactionQueue.close();
      transactionQueue = null;
      logger.info('[TransactionQueue] Queue closed');
    }

    if (connection && typeof connection.quit === 'function') {
      await connection.quit();
      logger.info('[TransactionQueue] Redis connection closed');
    }
  } catch (err) {
    logger.error('[TransactionQueue] Failed to close queue', { error: err.message });
  }
}

module.exports = {
  transactionQueue,
  enqueueTransaction,
  getJobStatus,
  startTransactionWorker,
  closeQueue,
  recoverPendingJobs,
  markResolved,
  markDead,
  QUEUE_NAME,
};
