'use strict';

const bullMQRetryService = require('../services/bullMQRetryService');
const logger = require('../utils/logger').child('BullMQAdminController');
const { logAudit } = require('../services/auditService');

/**
 * GET /api/admin/retry-queue/failed
 * List all failed jobs in the BullMQ dead-letter queue
 */
async function listFailedJobs(req, res, next) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;

    await bullMQRetryService.initializeRetryQueue();

    const jobs = await bullMQRetryService.getJobsByState('failed', limit + offset);
    const failedJobs = jobs.slice(offset, offset + limit);

    res.json({
      jobs: failedJobs,
      total: jobs.length,
      limit,
      offset,
    });
  } catch (err) {
    logger.error('Failed to list failed jobs', { error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/retry-queue/failed/:jobId
 * Get details of a specific failed job
 */
async function getFailedJobDetails(req, res, next) {
  try {
    const { jobId } = req.params;

    const jobDetails = await bullMQRetryService.getJobDetails(jobId);

    res.json(jobDetails);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    logger.error('Failed to get job details', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * POST /api/admin/retry-queue/failed/:jobId/retry
 * Re-enqueue a specific failed job for immediate retry
 */
async function retryFailedJob(req, res, next) {
  try {
    const { jobId } = req.params;

    const result = await bullMQRetryService.retryJobImmediately(jobId);

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'retry_failed_payment_job',
        performedBy: req.auditContext.performedBy,
        targetId: jobId,
        targetType: 'payment_job',
        details: { jobId },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Retried failed job', { jobId });

    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({
        error: err.message,
        code: 'INVALID_JOB_STATE',
      });
    }
    logger.error('Failed to retry job', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * DELETE /api/admin/retry-queue/failed/:jobId
 * Discard a failed job after investigation
 */
async function discardFailedJob(req, res, next) {
  try {
    const { jobId } = req.params;

    const result = await bullMQRetryService.removeJob(jobId);

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'discard_failed_payment_job',
        performedBy: req.auditContext.performedBy,
        targetId: jobId,
        targetType: 'payment_job',
        details: { jobId },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Discarded failed job', { jobId });

    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: `Job ${req.params.jobId} not found`,
        code: 'JOB_NOT_FOUND',
      });
    }
    logger.error('Failed to discard job', { jobId: req.params.jobId, error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/retry-queue/stats
 * Get comprehensive queue statistics including failed jobs count
 */
async function getQueueStats(req, res, next) {
  try {
    const stats = await bullMQRetryService.getRetryQueueStats();

    res.json(stats);
  } catch (err) {
    logger.error('Failed to get queue stats', { error: err.message });
    next(err);
  }
}

module.exports = {
  listFailedJobs,
  getFailedJobDetails,
  retryFailedJob,
  discardFailedJob,
  getQueueStats,
};
