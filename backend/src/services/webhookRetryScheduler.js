'use strict';

const { processPendingRetries } = require('./webhookService');
const logger = require('../utils/logger');

const INTERVAL_MS = parseInt(process.env.WEBHOOK_RETRY_INTERVAL_MS, 10) || 60_000;

let _timer = null;
let _running = false;

async function runOnce() {
  if (_running) {
    logger.warn('WEBHOOK_RETRY_SCHEDULER_SKIPPED', { reason: 'previous run still in progress' });
    return;
  }
  _running = true;
  const startedAt = Date.now();
  try {
    const result = await processPendingRetries();
    if (result.processed > 0) {
      logger.info('WEBHOOK_RETRY_PROCESSED', { count: result.processed });
    }
    logger.info('WEBHOOK_RETRY_SCHEDULER_RUN', {
      durationMs: Date.now() - startedAt,
      success: true,
      processed: result.processed,
    });
  } catch (err) {
    logger.error('WEBHOOK_RETRY_SCHEDULER_ERROR', {
      error: err.message,
      durationMs: Date.now() - startedAt,
      success: false,
    });
  } finally {
    _running = false;
  }
}

function scheduleNext() {
  _timer = setTimeout(async () => {
    await runOnce();
    if (_timer) scheduleNext();
  }, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

function startWebhookRetryScheduler() {
  if (_timer) return;
  scheduleNext();
}

async function stopWebhookRetryScheduler() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  while (_running) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

module.exports = { startWebhookRetryScheduler, stopWebhookRetryScheduler };
