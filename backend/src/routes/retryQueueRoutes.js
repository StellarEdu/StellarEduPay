/**
 * Retry Queue Routes
 * 
 * API endpoints for managing the transaction retry queue system.
 * All routes require admin authentication.
 *
 * #1592 — These routes are mounted synchronously in app.js (before the 404
 * handler) so they are always reachable. When the retry queue has not been
 * initialised yet, or when the MongoDB retry backend is active, handlers
 * respond with 503 RETRY_QUEUE_UNAVAILABLE instead of falling through to 404.
 */

'use strict';

const express = require('express');
const {
  getStats,
  getHealth,
  getJob,
  getJobs,
  manualRetry,
  deleteJob,
  pause,
  resume,
  queueTransaction,
} = require('../controllers/retryQueueController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

const router = express.Router();

// Apply admin auth to all retry queue routes
router.use(requireAdminAuth);

/**
 * Guard that ensures the retry queue is available before a handler runs.
 * Returns 503 RETRY_QUEUE_UNAVAILABLE when the queue is not initialised or
 * when the MongoDB retry backend is active (in which case the in-memory
 * retry queue admin API does not apply).
 */
function requireRetryQueue(req, res, next) {
  const retryQueue = req.app && req.app.locals && req.app.locals.retryQueue;
  const backend = process.env.RETRY_QUEUE_BACKEND;

  if (backend === 'mongodb' || !retryQueue) {
    return res.status(503).json({
      success: false,
      code: 'RETRY_QUEUE_UNAVAILABLE',
      message: 'Retry queue is not available',
    });
  }

  return next();
}

// Queue statistics and monitoring (read-only — no audit context needed)
router.get('/stats', requireRetryQueue, getStats);
router.get('/health', requireRetryQueue, getHealth);

// Job management
router.get('/jobs/:jobId', requireRetryQueue, getJob);
router.get('/jobs/state/:state', requireRetryQueue, getJobs);
// #1554 — state-changing operations require auditContext so every mutation is
// attributed to the acting administrator in the immutable audit trail.
router.post('/jobs/:jobId/retry', requireRetryQueue, auditContext, manualRetry);
router.delete('/jobs/:jobId', requireRetryQueue, auditContext, deleteJob);

// Queue control
router.post('/pause', requireRetryQueue, auditContext, pause);
router.post('/resume', requireRetryQueue, auditContext, resume);

// Manual transaction queuing
router.post('/queue', requireRetryQueue, auditContext, queueTransaction);

module.exports = router;
