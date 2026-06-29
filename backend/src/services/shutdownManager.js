'use strict';

/**
 * Graceful Shutdown Manager
 *
 * Coordinates safe shutdown of workers, queues, and SSE clients:
 *   1. Readiness flag flips before drain so LBs stop routing.
 *   2. Workers are drained (active jobs finish or are re-queued).
 *   3. SSE clients receive close/retry events.
 *   4. Force-exit only occurs after bounded drain timeout.
 */

const logger = require('../utils/logger').child('ShutdownManager');

const DRAIN_TIMEOUT_MS = parseInt(process.env.DRAIN_TIMEOUT_MS, 10) || 60_000;

let ready = true;
let shutdownStarted = false;

function setReady(value) {
  ready = value;
  logger.info(`Readiness set to ${value ? 'ready' : 'not_ready'}`);
}

function isReady() {
  return ready && !shutdownStarted;
}

function isShutdownInProgress() {
  return shutdownStarted;
}

async function drainWorkers() {
  const results = { txQueue: false, retryQueue: false };

  try {
    const txQueue = require('../queue/transactionQueue');
    if (txQueue.drainWorker) {
      const waitPromise = txQueue.drainWorker().catch((err) => ({ error: err.message }));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('transactionQueue drain timed out')), DRAIN_TIMEOUT_MS)
      );
      const result = await Promise.race([waitPromise, timeoutPromise]);
      if (result && !result.error) {
        results.txQueue = true;
      }
      logger.info('Transaction queue drained', { result });
    } else {
      results.txQueue = true;
    }
  } catch (err) {
    logger.error('Failed to drain transaction queue', { error: err.message });
  }

  try {
    const retryQueue = require('../queue/transactionRetryQueue');
    if (retryQueue.drainWorker) {
      const waitPromise = retryQueue.drainWorker().catch((err) => ({ error: err.message }));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('retryQueue drain timed out')), DRAIN_TIMEOUT_MS)
      );
      const result = await Promise.race([waitPromise, timeoutPromise]);
      if (result && !result.error) {
        results.retryQueue = true;
      }
      logger.info('Retry queue drained', { result });
    } else {
      results.retryQueue = true;
    }
  } catch (err) {
    logger.error('Failed to drain retry queue', { error: err.message });
  }

  return results;
}

async function notifySSEClients() {
  try {
    const sseService = require('./sseService');
    if (sseService.closeAll) {
      await sseService.closeAll();
      logger.info('SSE clients notified of shutdown');
    }
  } catch (err) {
    logger.error('Failed to notify SSE clients', { error: err.message });
  }
}

async function closeQueues() {
  const closeOps = [
    { name: 'transactionQueue', fn: async () => {
      const queue = require('../queue/transactionQueue');
      if (queue.closeQueue) await queue.closeQueue();
    }},
    { name: 'bullMQRetryQueue', fn: async () => {
      const retryQueue = require('../services/bullMQRetryService');
      if (retryQueue.shutdownQueue) await retryQueue.shutdownQueue();
    }},
  ];

  for (const op of closeOps) {
    try {
      await op.fn();
      logger.info(`${op.name} closed`);
    } catch (err) {
      logger.error(`Error closing ${op.name}`, { error: err.message });
    }
  }
}

async function stopAcceptingNewWork() {
  const stopOps = [
    { name: 'polling', fn: async () => {
      const polling = require('./transactionPollingService');
      if (polling.stopPolling) polling.stopPolling();
    }},
    { name: 'retrySelector', fn: async () => {
      const retrySelector = require('./retryServiceSelector');
      if (retrySelector.stop) retrySelector.stop();
    }},
    { name: 'leaderElection', fn: async () => {
      const leaderElection = require('./leaderElection');
      if (leaderElection.stop) await leaderElection.stop();
    }},
  ];

  for (const op of stopOps) {
    try {
      await op.fn();
      logger.info(`${op.name} stopped`);
    } catch (err) {
      logger.error(`Error stopping ${op.name}`, { error: err.message });
    }
  }
}

module.exports = {
  setReady,
  isReady,
  isShutdownInProgress,
  drainWorkers,
  notifySSEClients,
  closeQueues,
  stopAcceptingNewWork,
  DRAIN_TIMEOUT_MS,
};