'use strict';

/**
 * Periodic background recovery for the transaction processing queue (#1381).
 *
 * recoverPendingJobsWithRetry() covers the startup case: it retries with
 * exponential backoff while waiting for Redis to become ready, but gives up
 * after a bounded retry budget so a Redis outage doesn't hang process startup
 * forever. If that retry budget is exhausted, jobs that survived a restart
 * stay in MongoDB with status=pending and are never automatically retried
 * again — until now.
 *
 * This scheduler runs on the elected leader (a single instance is enough;
 * BullMQ dedupes by jobId=txHash, so a duplicate add() from another replica
 * would be a harmless no-op, but there is no reason to pay for it N times).
 * Each cycle it checks whether Redis is ready and, if so, re-runs
 * recoverPendingJobs() so any job stuck in MongoDB — whether from a failed
 * startup recovery or a mid-run Redis blip — is drained into BullMQ as soon
 * as Redis is available again, instead of waiting for the next process
 * restart.
 */

const { recoverPendingJobs } = require('../queue/transactionQueue');
const { isRedisReady } = require('../config/redisClient');
const logger = require('../utils/logger').child('JobRecoveryScheduler');
const { ping, markStarted, markStopped, WORKER_NAMES } = require('./workerHeartbeat');

const INTERVAL_MS = parseInt(process.env.JOB_RECOVERY_INTERVAL_MS, 10) || 60 * 1000;
let _timer = null;

async function runRecovery() {
  try {
    if (!isRedisReady()) {
      // Nothing to drain into yet — Redis is down, reconnecting, or not
      // configured. Skip this cycle; recovery resumes automatically once
      // Redis becomes ready again.
      ping(WORKER_NAMES.JOB_RECOVERY_SCHEDULER);
      return;
    }
    const recovered = await recoverPendingJobs();
    if (recovered > 0) {
      logger.info(`Drained ${recovered} stale pending job(s) into BullMQ`);
    }
    ping(WORKER_NAMES.JOB_RECOVERY_SCHEDULER);
  } catch (err) {
    logger.error('Periodic job recovery failed', { error: err.message });
    // Ping anyway so liveness reflects that the scheduler loop itself is
    // still running, even though the underlying recovery attempt failed.
    ping(WORKER_NAMES.JOB_RECOVERY_SCHEDULER);
  }
}

function startJobRecoveryScheduler() {
  if (_timer) return;
  markStarted(WORKER_NAMES.JOB_RECOVERY_SCHEDULER);
  runRecovery();
  _timer = setInterval(runRecovery, INTERVAL_MS);
}

function stopJobRecoveryScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    markStopped(WORKER_NAMES.JOB_RECOVERY_SCHEDULER);
  }
}

module.exports = { startJobRecoveryScheduler, stopJobRecoveryScheduler };
