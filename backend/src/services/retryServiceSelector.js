'use strict';

/**
 * Retry Service Selector
 *
 * Chooses the appropriate retry backend at startup:
 *   - BullMQ (Redis-backed) when REDIS_HOST is configured
 *   - MongoDB-backed retryService as fallback
 *
 * Only one service is started; they must never run simultaneously to avoid
 * processing the same failed transaction twice.
 */

const logger = require('../utils/logger').child('RetryServiceSelector');

let _selected = null; // 'bullmq' | 'mongodb'

function useBullMQ() {
  return Boolean(process.env.REDIS_HOST);
}

/**
 * Best-effort replica count from common orchestration env vars. Returns 1 when
 * unknown (single replica is the safe assumption for the warning below).
 * Set REPLICA_COUNT explicitly in multi-replica deployments for accuracy.
 */
function getReplicaCount() {
  const raw =
    process.env.REPLICA_COUNT ||
    process.env.WEB_CONCURRENCY ||
    process.env.INSTANCE_COUNT ||
    process.env.NUMBER_OF_REPLICAS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function start() {
  if (useBullMQ()) {
    _selected = 'bullmq';
    logger.info('REDIS_HOST is set — retry backend: BullMQ');
    // BullMQ is initialised via initializeRetryQueue() in retryQueueSetup.js
    // (called in app.js after DB connect). Nothing to start here.
  } else {
    _selected = 'mongodb';
    logger.info('REDIS_HOST not set — retry backend: MongoDB (retryService)');

    // Issue #81: the MongoDB backend's rate-limit counters and locks are
    // in-process. Running >1 replica against it means each replica retries the
    // same backlog independently — double-processing risk and no shared
    // rate-limit budget. Warn loudly; Redis/BullMQ is required for multi-replica.
    const replicas = getReplicaCount();
    if (replicas > 1) {
      logger.error(
        `[CRITICAL] In-process MongoDB retry backend is running with ${replicas} replicas. ` +
        'Rate-limit counters and retry coordination are per-process — replicas will ' +
        'independently re-drive the same failed transactions (double-processing risk). ' +
        'Set REDIS_HOST to use the BullMQ backend for any multi-replica deployment.'
      );
    }

    const { startRetryWorker } = require('./retryService');
    startRetryWorker();
  }
}

function stop() {
  if (_selected === 'mongodb') {
    const { stopRetryWorker } = require('./retryService');
    stopRetryWorker();
  }
  // BullMQ shutdown is handled by retryQueueSetup.js gracefulShutdown
}

function isRunning() {
  if (_selected === 'mongodb') {
    const { isRetryWorkerRunning } = require('./retryService');
    return isRetryWorkerRunning();
  }
  return false; // BullMQ workers are managed internally
}

function getSelectedBackend() {
  return _selected;
}

module.exports = { start, stop, isRunning, getSelectedBackend, useBullMQ, getReplicaCount };
