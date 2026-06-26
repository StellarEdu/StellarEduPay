/**
 * BullMQ Transaction Retry Queue Configuration
 * 
 * This module provides a production-ready job queue system for retrying
 * failed Stellar transactions with exponential backoff, dead-letter queue support,
 * comprehensive monitoring, and idempotency guarantees.
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const { getRedisClient, getRedisStatus } = require('../config/redisClient');

// Environment configuration
const config = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // BullMQ requires these on any connection it uses for blocking commands
    // (Worker / QueueEvents). Without them, createQueueEvents() throws:
    //   "Your redis options maxRetriesPerRequest must be null"
    // and the whole retry/dead-letter pipeline fails to initialize.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
  retry: {
    enabled: process.env.RETRIES_ENABLED !== 'false',
    maxAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS, 10) || 10,
    initialDelay: parseInt(process.env.INITIAL_RETRY_DELAY_MS, 10) || 60000,
    maxDelay: parseInt(process.env.MAX_RETRY_DELAY_MS, 10) || 3600000,
    backoffMultiplier: parseInt(process.env.RETRY_BACKOFF_MULTIPLIER, 10) || 2,
  },
  dlq: {
    enabled: process.env.DLQ_ENABLED !== 'false',
    maxAge: parseInt(process.env.DLQ_MAX_AGE_MS, 10) || 604800000, // 7 days
  },
  worker: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY, 10) || 5,
  },
  stellar: {
    timeout: parseInt(process.env.STELLAR_NETWORK_TIMEOUT_MS, 10) || 10000,
  },
};

// Queue names
const QUEUE_NAMES = {
  TRANSACTION_RETRY: 'transaction-retry-queue',
  DEAD_LETTER: 'transaction-dead-letter-queue',
};

// Redis connection instance
let redisConnection = null;

// Queue instances
let transactionRetryQueue = null;
let deadLetterQueue = null;
let queueEvents = null;
let retryWorker = null;

// Job state tracking for monitoring
const jobMetrics = {
  totalJobs: 0,
  successfulJobs: 0,
  failedJobs: 0,
  retriedJobs: 0,
  deadLetteredJobs: 0,
  lastJobProcessed: null,
  queueHealth: 'healthy',
};

// Event logging for monitoring
const eventLog = [];

/**
 * Initialize Redis connection
 */
function initializeRedisConnection() {
  if (!redisConnection) {
    redisConnection = getRedisClient();

    if (redisConnection) {
      redisConnection.on('error', (err) => {
        console.error('[TransactionRetryQueue] Redis connection error:', err.message);
        jobMetrics.queueHealth = 'unhealthy';
      });

      redisConnection.on('ready', () => {
        console.log('[TransactionRetryQueue] Redis connected successfully');
        jobMetrics.queueHealth = 'healthy';
      });
    }
  }
  return redisConnection;
}

/**
 * Create and configure the main transaction retry queue
 */
function createTransactionRetryQueue() {
  if (!transactionRetryQueue) {
    const redisConnection = initializeRedisConnection();
    if (!redisConnection) {
      throw new Error('Redis unavailable for retry queue initialization');
    }
    transactionRetryQueue = new Queue(QUEUE_NAMES.TRANSACTION_RETRY, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: config.retry.maxAttempts,
        backoff: {
          type: 'exponential',
          delay: config.retry.initialDelay,
        },
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: false, // Keep failed jobs for analysis
        jobId: null, // Auto-generate job IDs
      },
    });
  }
  return transactionRetryQueue;
}

/**
 * Create and configure the dead-letter queue
 */
function createDeadLetterQueue() {
  if (!deadLetterQueue && config.dlq.enabled) {
    const redisConnection = initializeRedisConnection();
    if (!redisConnection) {
      throw new Error('Redis unavailable for dead-letter queue initialization');
    }
    deadLetterQueue = new Queue(QUEUE_NAMES.DEAD_LETTER, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // No retries for dead-lettered jobs
        removeOnComplete: {
          age: config.dlq.maxAge, // Keep for configured period
          count: 10000, // Keep last 10000 dead-lettered jobs
        },
        removeOnFail: false, // Never remove failed dead-letter jobs
      },
    });
  }
  return deadLetterQueue;
}

/**
 * Create queue events listener for monitoring
 */
function createQueueEvents() {
  if (!queueEvents) {
    const redisConnection = initializeRedisConnection();
    if (!redisConnection) {
      throw new Error('Redis unavailable for queue events initialization');
    }
    queueEvents = new QueueEvents(QUEUE_NAMES.TRANSACTION_RETRY, {
      connection: redisConnection,
    });
  }
  return queueEvents;
}

/**
 * Calculate exponential backoff delay
 * @param {number} attempt - Current attempt number (1-indexed)
 * @returns {number} - Delay in milliseconds
 */
function calculateBackoffDelay(attempt) {
  const delay = Math.min(
    config.retry.initialDelay * Math.pow(config.retry.backoffMultiplier, attempt - 1),
    config.retry.maxDelay
  );
  return delay;
}

/**
 * Log events for monitoring and debugging
 */
function logEvent(eventType, data) {
  const event = {
    timestamp: new Date().toISOString(),
    type: eventType,
    data,
  };
  eventLog.push(event);
  
  // Keep only last 1000 events
  if (eventLog.length > 1000) {
    eventLog.shift();
  }
  
  console.log(`[TransactionRetryQueue] ${eventType}:`, JSON.stringify(data, null, 2));
}

/**
 * Move failed job to dead-letter queue
 */
async function moveToDeadLetterQueue(job, error) {
  if (!config.dlq.enabled) {
    logEvent('JOB_DLQ_SKIPPED', {
      jobId: job.id,
      reason: 'Dead-letter queue disabled',
      error: error.message,
    });
    return;
  }
  
  try {
    const dlq = createDeadLetterQueue();
    await dlq.add('dead-letter', {
      originalJobId: job.id,
      originalQueue: QUEUE_NAMES.TRANSACTION_RETRY,
      transactionHash: job.data.transactionHash,
      studentId: job.data.studentId,
      error: error.message,
      errorCode: error.code,
      failedAttempts: job.attemptsMade,
      originalJobData: job.data,
      failedAt: new Date().toISOString(),
    });
    
    jobMetrics.deadLetteredJobs++;
    logEvent('JOB_MOVED_TO_DLQ', {
      jobId: job.id,
      transactionHash: job.data.transactionHash,
      attempts: job.attemptsMade,
      error: error.message,
    });
  } catch (dlqError) {
    console.error('[TransactionRetryQueue] Failed to move job to DLQ:', dlqError.message);
    logEvent('DLQ_MOVE_ERROR', {
      jobId: job.id,
      error: dlqError.message,
    });
  }
}

/**
 * Check if transaction has already been successfully processed (idempotency check)
 */
async function isTransactionAlreadyProcessed(transactionHash) {
  const Payment = require('../models/paymentModel');
  const existingPayment = await Payment.findOne({ txHash: transactionHash });
  return existingPayment !== null;
}

/**
 * Process a transaction retry job
 */
async function processTransactionRetryJob(job) {
  const { transactionHash, studentId, memo, metadata } = job.data;
  
  logEvent('JOB_PROCESSING', {
    jobId: job.id,
    transactionHash,
    studentId,
    attempt: job.attemptsMade + 1,
    maxAttempts: config.retry.maxAttempts,
  });
  
  try {
    // Idempotency check - prevent duplicate processing
    if (await isTransactionAlreadyProcessed(transactionHash)) {
      logEvent('JOB_IDEMPOTENT_SKIP', {
        jobId: job.id,
        transactionHash,
        reason: 'Transaction already processed successfully',
      });
      return { 
        success: true, 
        skipped: true, 
        reason: 'Transaction already processed' 
      };
    }
    
    // Import Stellar service for transaction verification
    const { verifyTransaction, recordPayment } = require('../services/stellarService');
    
    // Verify transaction on Stellar network
    const result = await verifyTransaction(transactionHash);
    
    if (!result) {
      // Transaction verification failed - this is a permanent failure
      throw new Error(`Transaction ${transactionHash} verification returned null`);
    }
    
    // Record the successful payment
    await recordPayment({
      studentId: result.studentId || studentId,
      txHash: result.hash,
      amount: result.amount,
      feeAmount: result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      status: 'confirmed',
      memo: result.memo || memo,
      confirmedAt: result.date ? new Date(result.date) : new Date(),
    });
    
    jobMetrics.successfulJobs++;
    logEvent('JOB_COMPLETED', {
      jobId: job.id,
      transactionHash,
      attempts: job.attemptsMade + 1,
    });
    
    return {
      success: true,
      transactionHash,
      attempts: job.attemptsMade + 1,
      result,
    };
    
  } catch (error) {
    const isPermanentError = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 
                              'UNSUPPORTED_ASSET', 'DUPLICATE_TX'].includes(error.code);
    const hasReachedMaxAttempts = job.attemptsMade >= config.retry.maxAttempts - 1;
    
    if (isPermanentError || hasReachedMaxAttempts) {
      // Permanent failure or max attempts reached - move to DLQ
      await moveToDeadLetterQueue(job, error);
      jobMetrics.failedJobs++;
      
      logEvent('JOB_FAILED_PERMANENT', {
        jobId: job.id,
        transactionHash,
        error: error.message,
        errorCode: error.code,
        isPermanentError,
        hasReachedMaxAttempts,
        attempts: job.attemptsMade + 1,
      });
      
      throw error;
    } else {
      // Transient error - will be retried with backoff
      const nextDelay = calculateBackoffDelay(job.attemptsMade + 1);
      jobMetrics.retriedJobs++;
      
      logEvent('JOB_RETRY_SCHEDULED', {
        jobId: job.id,
        transactionHash,
        error: error.message,
        errorCode: error.code,
        currentAttempt: job.attemptsMade + 1,
        nextAttemptDelay: nextDelay,
      });
      
      // Create custom error with retry information
      const retryError = new Error(error.message);
      retryError.code = error.code;
      retryError.retryable = true;
      throw retryError;
    }
  }
}

/**
 * Create and start the retry worker
 */
function createRetryWorker() {
  if (!retryWorker) {
    const queue = createTransactionRetryQueue();
    
    retryWorker = new Worker(
      QUEUE_NAMES.TRANSACTION_RETRY,
      async (job) => await processTransactionRetryJob(job),
      {
        connection: initializeRedisConnection(),
        concurrency: config.worker.concurrency,
      }
    );
    
    // Worker event handlers
    retryWorker.on('completed', (job, result) => {
      jobMetrics.lastJobProcessed = new Date().toISOString();
      logEvent('WORKER_JOB_COMPLETED', {
        jobId: job.id,
        transactionHash: job.data.transactionHash,
        result,
      });
    });
    
    retryWorker.on('failed', (job, error) => {
      logEvent('WORKER_JOB_FAILED', {
        jobId: job.id,
        transactionHash: job.data.transactionHash,
        error: error.message,
        errorCode: error.code,
        attempts: job.attemptsMade,
      });
    });
    
    retryWorker.on('stalled', (jobId) => {
      logEvent('WORKER_JOB_STALLED', { jobId });
    });
    
    retryWorker.on('error', (error) => {
      console.error('[TransactionRetryQueue] Worker error:', error);
      logEvent('WORKER_ERROR', { error: error.message });
    });
    
    logEvent('WORKER_CREATED', {
      concurrency: config.worker.concurrency,
      queueName: QUEUE_NAMES.TRANSACTION_RETRY,
    });
  }
  return retryWorker;
}

/**
 * Set up queue event listeners for monitoring
 */
function setupEventListeners() {
  try {
    const events = createQueueEvents();

    events.on('waiting', ({ jobId }) => {
      jobMetrics.totalJobs++;
      logEvent('EVENT_WAITING', { jobId });
    });

    events.on('active', ({ jobId, prev }) => {
      logEvent('EVENT_ACTIVE', { jobId, previousState: prev });
    });

    events.on('completed', ({ jobId, returnvalue }) => {
      logEvent('EVENT_COMPLETED', { jobId, result: returnvalue });
    });

    events.on('failed', ({ jobId, failedReason }) => {
      logEvent('EVENT_FAILED', { jobId, reason: failedReason });
    });

    events.on('stalled', ({ jobId }) => {
      logEvent('EVENT_STALLED', { jobId });
    });

    events.on('retries-exhausted', ({ jobId }) => {
      logEvent('EVENT_RETRIES_EXHAUSTED', { jobId });
    });

    events.on('progress', ({ jobId, progress }) => {
      logEvent('EVENT_PROGRESS', { jobId, progress });
    });

    logEvent('EVENT_LISTENERS_SETUP', {
      queueName: QUEUE_NAMES.TRANSACTION_RETRY,
    });
  } catch (err) {
    console.error('[TransactionRetryQueue] Failed to setup event listeners:', err.message);
    jobMetrics.queueHealth = 'unhealthy';
  }
}

/**
 * Add a transaction to the retry queue
 */
async function addTransactionToRetryQueue(transactionHash, studentId = null, metadata = {}) {
  if (!config.retry.enabled) {
    logEvent('RETRY_DISABLED', { transactionHash, reason: 'RETRIES_ENABLED is false' });
    return null;
  }
  
  try {
    const queue = createTransactionRetryQueue();
    
    // Generate idempotency key to prevent duplicate jobs
    const jobId = `tx-${transactionHash}`;
    
    // Check if job already exists
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const jobState = await existingJob.getState();
      if (jobState === 'completed') {
        logEvent('JOB_DUPLICATE_COMPLETED', { jobId, transactionHash });
        return { jobId, status: 'already_completed' };
      } else if (jobState === 'waiting' || jobState === 'delayed') {
        logEvent('JOB_DUPLICATE_PENDING', { jobId, transactionHash });
        return { jobId, status: 'already_queued' };
      }
    }
    
    // Add job to queue with custom backoff
    const job = await queue.add('transaction-retry', {
      transactionHash,
      studentId,
      metadata,
      queuedAt: new Date().toISOString(),
    }, {
      jobId,
      backoff: {
        type: 'custom',
      },
      delay: config.retry.initialDelay, // Initial delay before first retry
    });
    
    logEvent('JOB_ADDED', {
      jobId: job.id,
      transactionHash,
      studentId,
      delay: config.retry.initialDelay,
    });
    
    return job;
    
  } catch (error) {
    console.error('[TransactionRetryQueue] Failed to add job:', error);
    logEvent('JOB_ADD_ERROR', {
      transactionHash,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get queue statistics and health metrics
 */
async function getQueueStats() {
  try {
    const queue = createTransactionRetryQueue();

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      queue: QUEUE_NAMES.TRANSACTION_RETRY,
      health: jobMetrics.queueHealth,
      redisStatus: getRedisStatus(),
      metrics: {
        ...jobMetrics,
        waiting,
        active,
        completed,
        failed,
        delayed,
        totalJobs: waiting + active + completed + failed + delayed,
      },
      config: {
        maxAttempts: config.retry.maxAttempts,
        initialDelay: config.retry.initialDelay,
        maxDelay: config.retry.maxDelay,
        backoffMultiplier: config.retry.backoffMultiplier,
        concurrency: config.worker.concurrency,
        dlqEnabled: config.dlq.enabled,
      },
      recentEvents: eventLog.slice(-50), // Last 50 events
    };
  } catch (err) {
    return {
      queue: QUEUE_NAMES.TRANSACTION_RETRY,
      health: 'unhealthy',
      redisStatus: getRedisStatus(),
      metrics: {
        ...jobMetrics,
      },
      config: {
        maxAttempts: config.retry.maxAttempts,
        initialDelay: config.retry.initialDelay,
        maxDelay: config.retry.maxDelay,
        backoffMultiplier: config.retry.backoffMultiplier,
        concurrency: config.worker.concurrency,
        dlqEnabled: config.dlq.enabled,
      },
      recentEvents: eventLog.slice(-50),
      error: err.message,
    };
  }
}

/**
 * Get dead-letter queue statistics
 */
async function getDLQStats() {
  if (!config.dlq.enabled || !deadLetterQueue) {
    return { enabled: false };
  }
  
  const [waiting, completed, failed] = await Promise.all([
    deadLetterQueue.getWaitingCount(),
    deadLetterQueue.getCompletedCount(),
    deadLetterQueue.getFailedCount(),
  ]);
  
  return {
    queue: QUEUE_NAMES.DEAD_LETTER,
    enabled: true,
    metrics: {
      waiting,
      completed,
      failed,
    },
  };
}

/**
 * Gracefully shutdown all queue components
 */
async function shutdownQueue() {
  console.log('[TransactionRetryQueue] Shutting down...');
  
  try {
    if (retryWorker) {
      await retryWorker.close();
      console.log('[TransactionRetryQueue] Worker closed');
    }
    
    if (transactionRetryQueue) {
      await transactionRetryQueue.close();
      console.log('[TransactionRetryQueue] Main queue closed');
    }
    
    if (deadLetterQueue) {
      await deadLetterQueue.close();
      console.log('[TransactionRetryQueue] Dead-letter queue closed');
    }
    
    if (queueEvents) {
      await queueEvents.close();
      console.log('[TransactionRetryQueue] Queue events closed');
    }
    
    if (redisConnection) {
      await redisConnection.quit();
      console.log('[TransactionRetryQueue] Redis connection closed');
    }
    
    logEvent('QUEUE_SHUTDOWN', { timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[TransactionRetryQueue] Error during shutdown:', error);
  }
}

/**
 * Initialize the transaction retry queue system
 */
async function initializeQueue() {
  console.log('[TransactionRetryQueue] Initializing...');
  console.log('[TransactionRetryQueue] Configuration:', JSON.stringify(config, null, 2));
  
  try {
    // Initialize Redis connection
    initializeRedisConnection();
    
    // Create queues
    createTransactionRetryQueue();
    createDeadLetterQueue();
    
    // Set up event listeners
    setupEventListeners();
    
    // Create and start worker
    createRetryWorker();
    
    logEvent('QUEUE_INITIALIZED', {
      timestamp: new Date().toISOString(),
      config,
    });
    
    console.log('[TransactionRetryQueue] Initialization complete');
    return {
      queue: transactionRetryQueue,
      worker: retryWorker,
      addJob: addTransactionToRetryQueue,
      getStats: getQueueStats,
      getDLQStats,
      shutdown: shutdownQueue,
    };
  } catch (err) {
    console.error('[TransactionRetryQueue] Initialization failed:', err.message);
    throw err;
  }
}

module.exports = {
  initializeQueue,
  addTransactionToRetryQueue,
  getQueueStats,
  getDLQStats,
  calculateBackoffDelay,
  shutdownQueue,
  config,
  QUEUE_NAMES,
};
