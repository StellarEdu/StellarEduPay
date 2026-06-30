'use strict';

const client = require('prom-client');

const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

// payments_total{status} — queried live from MongoDB on each scrape so the
// count is accurate even after a process restart (counters would reset to 0).
new client.Gauge({
  name: 'payments_total',
  help: 'Number of payments grouped by status',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    try {
      const Payment = require('../models/paymentModel');
      const counts = await Payment.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      this.reset();
      for (const { _id, count } of counts) {
        this.set({ status: _id }, count);
      }
    } catch (_) {
      // DB may not be ready yet — scrape still succeeds with stale/zero values
    }
  },
});

// sync_duration_seconds — recorded per manual sync operation in paymentController
const syncDurationSeconds = new client.Histogram({
  name: 'sync_duration_seconds',
  help: 'Duration of payment sync operations in seconds',
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

// queue_depth{queue} — queried live from BullMQ on each scrape.
// Tracks actionable (non-completed) jobs: waiting + active + delayed.
new client.Gauge({
  name: 'queue_depth',
  help: 'Number of actionable jobs in each BullMQ queue (waiting + active + delayed)',
  labelNames: ['queue'],
  registers: [registry],
  async collect() {
    try {
      const { getQueueStats, getDLQStats } = require('../queue/transactionRetryQueue');
      const [retryResult, dlqResult] = await Promise.allSettled([
        getQueueStats(),
        getDLQStats(),
      ]);

      this.reset();

      if (retryResult.status === 'fulfilled' && retryResult.value?.metrics) {
        const m = retryResult.value.metrics;
        this.set(
          { queue: 'transaction-retry' },
          (m.waiting || 0) + (m.active || 0) + (m.delayed || 0)
        );
      }

      if (dlqResult.status === 'fulfilled' && dlqResult.value?.enabled) {
        const m = dlqResult.value.metrics;
        this.set({ queue: 'transaction-dead-letter' }, m.waiting || 0);
      }
    } catch (_) {
      // Redis may not be configured — scrape still succeeds
    }
  },
});

// queue_failed{queue} — number of jobs currently in the failed state per
// BullMQ queue, plus the dead-letter backlog. Operators alert on any sustained
// growth here: a rising failed count means retries are exhausting, and any
// dead-letter accumulation means jobs need manual inspection (Issue #82).
new client.Gauge({
  name: 'queue_failed',
  help: 'Number of failed/dead-lettered jobs per BullMQ queue',
  labelNames: ['queue'],
  registers: [registry],
  async collect() {
    try {
      const { getQueueStats, getDLQStats } = require('../queue/transactionRetryQueue');
      const [retryResult, dlqResult] = await Promise.allSettled([
        getQueueStats(),
        getDLQStats(),
      ]);

      this.reset();

      if (retryResult.status === 'fulfilled' && retryResult.value?.metrics) {
        this.set({ queue: 'transaction-retry' }, retryResult.value.metrics.failed || 0);
      }

      if (dlqResult.status === 'fulfilled' && dlqResult.value?.enabled) {
        const m = dlqResult.value.metrics;
        // Dead-lettered jobs land as waiting in the DLQ (no DLQ worker drains them).
        this.set({ queue: 'transaction-dead-letter' }, (m.waiting || 0) + (m.failed || 0));
      }
    } catch (_) {
      // Redis may not be configured — scrape still succeeds
    }
  },
});

// sse_connected_clients / sse_active_schools — current SSE fan-out registry
// size on this replica, read live from the SSE service on each scrape.
new client.Gauge({
  name: 'sse_connected_clients',
  help: 'Number of currently connected SSE clients on this replica',
  registers: [registry],
  collect() {
    try {
      const { connections } = require('../services/sseService').getStats();
      this.set(connections);
    } catch (_) {
      // SSE service not loaded — scrape still succeeds
    }
  },
});

new client.Gauge({
  name: 'sse_active_schools',
  help: 'Number of schools with at least one connected SSE client on this replica',
  registers: [registry],
  collect() {
    try {
      const { schools } = require('../services/sseService').getStats();
      this.set(schools);
    } catch (_) {
      // SSE service not loaded — scrape still succeeds
    }
  },
});

// pending_verification_backlog{status} — depth of the Stellar verification
// retry backlog, queried live from MongoDB on each scrape. Operators alert on a
// growing `pending`/`processing` backlog or any `dead_letter` accumulation.
new client.Gauge({
  name: 'pending_verification_backlog',
  help: 'Number of pending verification records grouped by status (pending, processing, resolved, dead_letter)',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    try {
      const { getBacklogCounts } = require('../services/retryService');
      const counts = await getBacklogCounts();
      this.reset();
      for (const [status, count] of Object.entries(counts)) {
        this.set({ status }, count);
      }
    } catch (_) {
      // DB may not be ready yet — scrape still succeeds
    }
  },
});

// suspicious_payment_flagged{school_id} — counter of payments flagged as
// suspicious by the abnormal-pattern detector, so operators can alert on
// flagged volume per tenant. Incremented in the payment confirmation pipeline.
const suspiciousPaymentFlagged = new client.Counter({
  name: 'suspicious_payment_flagged',
  help: 'Number of payments flagged as suspicious, labelled by school',
  labelNames: ['school_id'],
  registers: [registry],
});

// Concurrent payment batch metrics — recorded by the concurrentPaymentProcessor
// after each processBatch() call so batch throughput and per-item outcomes are
// observable and alertable.
const paymentBatchTotal = new client.Counter({
  name: 'payment_batch_total',
  help: 'Number of payment batches processed',
  registers: [registry],
});

const paymentBatchItemsTotal = new client.Counter({
  name: 'payment_batch_items_total',
  help: 'Number of payment batch items grouped by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

const paymentBatchDurationSeconds = new client.Histogram({
  name: 'payment_batch_duration_seconds',
  help: 'Duration of a payment batch in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

// http_request_duration_seconds{method,route,status} — recorded per request
// in the requestLogger middleware, which already captures these fields.
const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

module.exports = {
  registry,
  syncDurationSeconds,
  httpRequestDurationSeconds,
  suspiciousPaymentFlagged,
  paymentBatchTotal,
  paymentBatchItemsTotal,
  paymentBatchDurationSeconds,
};
