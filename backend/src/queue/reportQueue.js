'use strict';

const { Queue, Worker } = require('bullmq');
const { getRedisClient } = require('../config/redisClient');
const { ReportJob, REPORT_STATUSES } = require('../models/reportJobModel');
const logger = require('../utils/logger');
const { randomUUID } = require('crypto');

const QUEUE_NAME = 'report-generation';
const REPORT_JOB_TTL_MS = parseInt(process.env.REPORT_JOB_TTL_MS || String(6 * 60 * 60 * 1000), 10);

let reportQueue = null;
let worker = null;

function createQueue() {
  if (!getRedisClient()) {
    logger.warn('[ReportQueue] Redis not configured — report queue unavailable');
    return null;
  }

  try {
    reportQueue = new Queue(QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: false,
      },
    });
    return reportQueue;
  } catch (err) {
    logger.error('[ReportQueue] Failed to create queue', { error: err.message });
    return null;
  }
}

async function enqueueReportJob(jobData) {
  if (!reportQueue) {
    const err = new Error('Report queue unavailable — Redis not configured');
    err.code = 'QUEUE_UNAVAILABLE';
    throw err;
  }

  const jobId = `report-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + REPORT_JOB_TTL_MS);

  const reportJob = await ReportJob.create({
    schoolId: jobData.schoolId,
    jobId,
    type: jobData.type,
    status: REPORT_STATUSES.PENDING,
    params: {
      startDate: jobData.startDate || null,
      endDate: jobData.endDate || null,
      timezone: jobData.timezone || 'UTC',
      schemaVersion: jobData.schemaVersion || null,
    },
    expiresAt,
  });

  const job = await reportQueue.add(
    'generate-report',
    { jobId, ...jobData },
    { jobId }
  );

  logger.info('[ReportQueue] Report job enqueued', { jobId, type: jobData.type, schoolId: jobData.schoolId });
  return { jobId, reportJob };
}

async function getReportJob(jobId) {
  return ReportJob.findOne({ jobId }).lean();
}

async function getJobStatus(jobId) {
  const reportJob = await ReportJob.findOne({ jobId }).lean();
  if (!reportJob) return null;

  return {
    jobId: reportJob.jobId,
    type: reportJob.type,
    status: reportJob.status,
    params: reportJob.params,
    error: reportJob.result?.error || null,
    createdAt: reportJob.createdAt,
    startedAt: reportJob.startedAt,
    completedAt: reportJob.completedAt,
    downloadUrl: reportJob.status === REPORT_STATUSES.COMPLETED ? reportJob.downloadUrl : null,
  };
}

async function setJobProcessing(jobId) {
  await ReportJob.findOneAndUpdate(
    { jobId, status: REPORT_STATUSES.PENDING },
    { status: REPORT_STATUSES.PROCESSING, startedAt: new Date() }
  );
}

async function setJobCompleted(jobId, result) {
  await ReportJob.findOneAndUpdate(
    { jobId, status: REPORT_STATUSES.PROCESSING },
    { status: REPORT_STATUSES.COMPLETED, completedAt: new Date(), result }
  );
}

async function setJobFailed(jobId, error) {
  await ReportJob.findOneAndUpdate(
    { jobId, status: { $in: [REPORT_STATUSES.PENDING, REPORT_STATUSES.PROCESSING] } },
    { status: REPORT_STATUSES.FAILED, completedAt: new Date(), 'result.error': error?.message || String(error) }
  );
}

function startReportWorker(processor) {
  if (worker) return worker;

  const connection = getRedisClient();
  if (!connection) {
    logger.warn('[ReportQueue] Redis unavailable — report worker not started');
    return null;
  }

  worker = new Worker(QUEUE_NAME, processor, {
    connection,
    concurrency: parseInt(process.env.REPORT_QUEUE_CONCURRENCY, 10) || 2,
  });

  worker.on('completed', (job) => {
    logger.info('[ReportQueue] Job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('[ReportQueue] Job failed', {
      jobId: job?.id,
      error: err.message,
    });
  });

  logger.info('[ReportQueue] Worker started', {
    concurrency: parseInt(process.env.REPORT_QUEUE_CONCURRENCY, 10) || 2,
  });

  return worker;
}

async function closeQueue() {
  try {
    if (reportQueue) {
      await reportQueue.close();
      reportQueue = null;
    }
    if (worker) {
      await worker.close();
      worker = null;
    }
  } catch (err) {
    logger.error('[ReportQueue] Failed to close queue', { error: err.message });
  }
}

module.exports = {
  createQueue,
  enqueueReportJob,
  getReportJob,
  getJobStatus,
  setJobProcessing,
  setJobCompleted,
  setJobFailed,
  startReportWorker,
  closeQueue,
  QUEUE_NAME,
};