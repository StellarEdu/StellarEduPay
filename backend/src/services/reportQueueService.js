'use strict';

const {
  startReportWorker,
  setJobProcessing,
  setJobCompleted,
  setJobFailed,
  closeQueue,
  QUEUE_NAME,
} = require('../queue/reportQueue');
const {
  generateReport,
  generateAccountingCsv,
  reportToCsv,
} = require('./reportService');
const logger = require('../utils/logger');

async function processReportJob(job) {
  const { jobId, schoolId, type, startDate, endDate, timezone, schemaVersion } = job.data;

  await setJobProcessing(jobId);
  logger.info('[ReportQueueService] Processing report job', { jobId, type, schoolId });

  try {
    if (type === 'accounting_csv') {
      const { csv, schemaVersion: sv } = await generateAccountingCsv({ schoolId, startDate, endDate });
      await setJobCompleted(jobId, { csv, schemaVersion: sv });
      return { success: true, jobId, type };
    }

    const report = await generateReport({ schoolId, startDate, endDate, timezone });
    await setJobCompleted(jobId, { report });
    return { success: true, jobId, type };
  } catch (err) {
    await setJobFailed(jobId, err);
    throw err;
  }
}

let worker = null;

async function startWorker() {
  if (worker) return worker;
  worker = startReportWorker(processReportJob);
  if (worker) {
    logger.info('[ReportQueueService] Report worker started');
  }
  return worker;
}

async function stopWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
  await closeQueue();
}

module.exports = {
  startWorker,
  stopWorker,
};