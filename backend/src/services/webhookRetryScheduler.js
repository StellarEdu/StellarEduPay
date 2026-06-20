'use strict';

const { processPendingRetries } = require('./webhookService');
const logger = require('../utils/logger');

const INTERVAL_MS = parseInt(process.env.WEBHOOK_RETRY_INTERVAL_MS, 10) || 60_000;

let _timer = null;

async function runOnce() {
  try {
    const result = await processPendingRetries();
    if (result.processed > 0) {
      logger.info('WEBHOOK_RETRY_PROCESSED', { count: result.processed });
    }
  } catch (err) {
    logger.error('WEBHOOK_RETRY_SCHEDULER_ERROR', { error: err.message });
  }
}

function startWebhookRetryScheduler() {
  if (_timer) return;
  _timer = setInterval(runOnce, INTERVAL_MS);
  _timer.unref();
}

function stopWebhookRetryScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startWebhookRetryScheduler, stopWebhookRetryScheduler };
