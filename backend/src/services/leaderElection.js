'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const SystemConfig = require('../models/SystemConfig');
const { register, Gauge } = require('prom-client');

// Interval at which we check whether a durable job is due. Short enough that a
// daily job still fires promptly after a restart or leader change.
const JOB_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Gauge exposing the last successful run timestamp (seconds since epoch) per job.
let jobLastSuccessGauge = null;
function getJobLastSuccessGauge() {
  if (jobLastSuccessGauge) return jobLastSuccessGauge;
  try {
    jobLastSuccessGauge = new Gauge({
      name: 'job_last_success_timestamp_seconds',
      help: 'Unix timestamp of the last successful run of a scheduled job',
      labelNames: ['job'],
    });
    register.registerMetric(jobLastSuccessGauge);
  } catch (err) {
    // Metric may already be registered (e.g. hot reload); reuse the existing one.
    jobLastSuccessGauge = register.getSingleMetric('job_last_success_timestamp_seconds') || null;
  }
  return jobLastSuccessGauge;
}

// Durable, restart-safe scheduled jobs. Each entry runs at most once per
// `intervalMs`, tracked via a persisted `lastRunAt` so restarts and leader
// changes cannot reset the timer and skip a daily run.
const durableJobs = [];
let durableJobsTimer = null;
let durableJobsRunning = false;

function registerDurableJob(name, intervalMs, run) {
  if (!name || typeof run !== 'function') return;
  if (durableJobs.some((job) => job.name === name)) return;
  durableJobs.push({ name, intervalMs, run });
}

async function getLastRunAt(name) {
  const config = await SystemConfig.findOne({ key: `scheduled_job:${name}:lastRunAt` }).lean();
  if (!config || !config.value) return null;
  const ts = new Date(config.value);
  return Number.isNaN(ts.getTime()) ? null : ts;
}

async function setLastRunAt(name, when) {
  await SystemConfig.updateOne(
    { key: `scheduled_job:${name}:lastRunAt` },
    { $set: { key: `scheduled_job:${name}:lastRunAt`, value: when.toISOString() } },
    { upsert: true }
  );
}

async function runDurableJobs() {
  if (durableJobsRunning) return;
  durableJobsRunning = true;
  try {
    const now = Date.now();
    for (const job of durableJobs) {
      try {
        const lastRunAt = await getLastRunAt(job.name);
        const due = !lastRunAt || now - lastRunAt.getTime() >= job.intervalMs;
        if (!due) continue;

        await job.run();

        const completedAt = new Date();
        await setLastRunAt(job.name, completedAt);

        const gauge = getJobLastSuccessGauge();
        if (gauge) gauge.set({ job: job.name }, Math.floor(completedAt.getTime() / 1000));

        logger.info(`Durable job "${job.name}" completed`);
      } catch (err) {
        logger.error(`Durable job "${job.name}" failed: ${err.message}`);
      }
    }
  } finally {
    durableJobsRunning = false;
  }
}

function startDurableJobs() {
  if (durableJobsTimer) return;
  // Run immediately on start so a restart/leader change does not delay a due job.
  runDurableJobs().catch((err) => logger.error(`Durable jobs initial run failed: ${err.message}`));
  durableJobsTimer = setInterval(() => {
    runDurableJobs().catch((err) => logger.error(`Durable jobs check failed: ${err.message}`));
  }, JOB_CHECK_INTERVAL_MS);
  if (durableJobsTimer.unref) durableJobsTimer.unref();
}

function stopDurableJobs() {
  if (durableJobsTimer) {
    clearInterval(durableJobsTimer);
    durableJobsTimer = null;
  }
}

/**
 * Leader election service.
 *
 * Uses a MongoDB-based lock to ensure only one instance runs leader-only
 * schedulers at a time. When leadership is acquired the leader schedulers are
 * started; when it is lost they are stopped.
 */
class LeaderElection {
  constructor(options = {}) {
    this.lockId = options.lockId || 'leader-election';
    this.leaseDurationMs = options.leaseDurationMs || 30 * 1000;
    this.renewIntervalMs = options.renewIntervalMs || 10 * 1000;
    this.isLeader = false;
    this.renewTimer = null;
    this.schedulers = [];
  }

  async acquireLock() {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseDurationMs);

    try {
      const result = await SystemConfig.findOneAndUpdate(
        {
          key: this.lockId,
          $or: [{ value: { $exists: false } }, { expiresAt: { $lt: now } }],
        },
        { $set: { key: this.lockId, value: 'locked', expiresAt } },
        { upsert: true, new: true }
      );
      return !!result;
    } catch (err) {
      // Duplicate key on upsert means another instance holds the lock.
      if (err && err.code === 11000) return false;
      throw err;
    }
  }

  async renewLock() {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseDurationMs);
    const result = await SystemConfig.findOneAndUpdate(
      { key: this.lockId, value: 'locked' },
      { $set: { expiresAt } },
      { new: true }
    );
    return !!result;
  }

  async releaseLock() {
    await SystemConfig.updateOne(
      { key: this.lockId, value: 'locked' },
      { $set: { value: '', expiresAt: new Date(0) } }
    );
  }

  registerScheduler(scheduler) {
    this.schedulers.push(scheduler);
  }

  startLeaderSchedulers() {
    for (const scheduler of this.schedulers) {
      try {
        if (typeof scheduler.start === 'function') scheduler.start();
      } catch (err) {
        logger.error(`Failed to start scheduler: ${err.message}`);
      }
    }
    startDurableJobs();
  }

  stopLeaderSchedulers() {
    for (const scheduler of this.schedulers) {
      try {
        if (typeof scheduler.stop === 'function') scheduler.stop();
      } catch (err) {
        logger.error(`Failed to stop scheduler: ${err.message}`);
      }
    }
    stopDurableJobs();
  }

  async start() {
    const acquired = await this.acquireLock();
    if (acquired) {
      this.isLeader = true;
      logger.info('Acquired leader lock');
      this.startLeaderSchedulers();
    }

    this.renewTimer = setInterval(async () => {
      try {
        if (this.isLeader) {
          const renewed = await this.renewLock();
          if (!renewed) {
            logger.warn('Lost leader lock');
            this.isLeader = false;
            this.stopLeaderSchedulers();
          }
        } else {
          const acquiredNow = await this.acquireLock();
          if (acquiredNow) {
            this.isLeader = true;
            logger.info('Acquired leader lock');
            this.startLeaderSchedulers();
          }
        }
      } catch (err) {
        logger.error(`Leader election error: ${err.message}`);
      }
    }, this.renewIntervalMs);
    if (this.renewTimer.unref) this.renewTimer.unref();
  }

  async stop() {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    this.stopLeaderSchedulers();
    if (this.isLeader) {
      await this.releaseLock();
      this.isLeader = false;
    }
  }
}

module.exports = LeaderElection;
module.exports.LeaderElection = LeaderElection;
module.exports.registerDurableJob = registerDurableJob;
module.exports.startDurableJobs = startDurableJobs;
module.exports.stopDurableJobs = stopDurableJobs;
module.exports.runDurableJobs = runDurableJobs;
module.exports.JOB_CHECK_INTERVAL_MS = JOB_CHECK_INTERVAL_MS;
