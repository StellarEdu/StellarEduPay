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

const stuckPaymentsGauge = new client.Gauge({
  name: 'stuck_payments',
  help: 'Number of stuck payments awaiting reconciliation',
  registers: [registry],
  async collect() {
    try {
      const { STUCK_PAYMENT_THRESHOLD_MS } = require('../services/stuckPaymentReconciliation');
      const Payment = require('../models/paymentModel');
      const count = await Payment.countDocuments({
        status: 'SUBMITTED',
        submittedAt: { $lt: new Date(Date.now() - STUCK_PAYMENT_THRESHOLD_MS) },
        deletedAt: null,
      });
      this.set(count);
    } catch (_) {
      // DB may not be ready yet — scrape still succeeds with stale/zero values
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

// Payment limit rejections (#1117). Without this there is no signal telling
// operators that the configured limits are being hit often enough to warrant
// adjusting — the limits were previously a control nobody could observe.
// `code` distinguishes AMOUNT_TOO_LOW from AMOUNT_TOO_HIGH: a spike in the
// latter is the fraud/misconfiguration signal worth alerting on.
const paymentLimitTriggeredTotal = new client.Counter({
  name: 'payment_limit_triggered_total',
  help: 'Number of payments rejected by the configured payment limits',
  labelNames: ['school_id', 'asset', 'code'],
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

// payment_funnel_total{stage, school_id} — tracks each stage of the payment
// processing funnel: received (tx seen by poller), validated (passes
// amount/memo checks), matched (student found), confirmed (saved to DB).
// CARDINALITY NOTE: school_id label bounded to tenant count; never use studentId or txHash as labels
const paymentFunnelTotal = new client.Counter({
  name: 'payment_funnel_total',
  help: 'Number of payments at each processing stage (received, validated, matched, confirmed)',
  labelNames: ['stage', 'school_id'],
  registers: [registry],
});

// horizon_request_duration_seconds{operation} — latency histogram for outbound
// calls to the Stellar Horizon API. Operations: loadAccount, payments, transactions.
const horizonRequestDurationSeconds = new client.Histogram({
  name: 'horizon_request_duration_seconds',
  help: 'Duration of Horizon API requests in seconds',
  labelNames: ['operation'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

// webhook_delivery_total{outcome} — counts webhook delivery attempts by outcome.
// outcomes: 'success' (HTTP 2xx), 'failure' (error or non-2xx), 'retry' (queued for retry).
const webhookDeliveryTotal = new client.Counter({
  name: 'webhook_delivery_total',
  help: 'Number of webhook delivery attempts grouped by outcome (success, failure, retry)',
  labelNames: ['outcome'],
  registers: [registry],
});

// notification_sent_total{channel} — counts outbound notifications by channel.
// channels: 'email', 'sms', 'whatsapp'. smsService increments 'sms'/'whatsapp'.
const notificationSentTotal = new client.Counter({
  name: 'notification_sent_total',
  help: 'Number of notifications sent grouped by delivery channel (email, sms, whatsapp)',
  labelNames: ['channel'],
  registers: [registry],
});

// ── Coordinated Horizon poll budget (#1124) ─────────────────────────────────
// Polling draws from a single per-cycle request allowance shared across all
// schools, spent in priority order. These expose whether that allowance binds,
// how far the adaptive ceiling has been pulled down by observed 429s, and — the
// SLA-relevant one — the worst staleness any tenant is currently experiencing.
const horizonPollBudgetRemaining = new client.Gauge({
  name: 'horizon_poll_budget_remaining',
  help: 'Horizon request tokens left in the current poll cycle budget',
  registers: [registry],
});

const horizonPollBudgetCeiling = new client.Gauge({
  name: 'horizon_poll_budget_ceiling',
  help: 'Current adaptive per-cycle Horizon request ceiling (AIMD-adjusted)',
  registers: [registry],
});

const horizonPollDeferredSchools = new client.Gauge({
  name: 'horizon_poll_deferred_schools',
  help: 'Number of schools currently deferred because the poll budget was exhausted',
  registers: [registry],
});

// The direct input to the documented max-sync-delay SLA: worst-case delay is
// approximately (this value + 1) x the poll interval.
const horizonPollMaxDeferralCycles = new client.Gauge({
  name: 'horizon_poll_max_deferral_cycles',
  help: 'Highest number of consecutive cycles any single school has been deferred',
  registers: [registry],
});

const horizonPollRequestsTotal = new client.Counter({
  name: 'horizon_poll_requests_total',
  help: 'Total Horizon page requests issued by the transaction poller',
  registers: [registry],
});

const horizonRateLimitedTotal = new client.Counter({
  name: 'horizon_rate_limited_total',
  help: 'Number of Horizon responses observed as HTTP 429 by the poller',
  registers: [registry],
});

// mongodb_connection_state — live mongoose readyState (0=disconnected,
// 1=connected, 2=connecting, 3=disconnecting). Read fresh on each scrape so it
// reflects reality even across reconnect cycles the app never explicitly logs.
const mongoConnectionState = new client.Gauge({
  name: 'mongodb_connection_state',
  help: 'Current MongoDB connection state (0=disconnected, 1=connected, 2=connecting, 3=disconnecting)',
  registers: [registry],
  collect() {
    try {
      const mongoose = require('mongoose');
      this.set(mongoose.connection.readyState);
    } catch (_) {
      // mongoose not loaded — scrape still succeeds
    }
  },
});

// mongodb_connection_errors_total — incremented from the driver's 'error'
// event handler in config/database.js. Connection state alone can't tell a
// clean disconnect from a string of driver errors that never trip readyState.
const mongoConnectionErrorsTotal = new client.Counter({
  name: 'mongodb_connection_errors_total',
  help: 'Total number of MongoDB connection error events emitted by the driver',
  registers: [registry],
});

// payment_processor_queue_depth / *_high_water / *_max_depth — the
// in-process concurrent payment processor queue that MAX_QUEUE_DEPTH and
// QUEUE_BACKPRESSURE_HIGH_WATER (config/index.js) govern. The thresholds are
// exposed as gauges (not hardcoded in alert expressions) so an alert stays
// correct if an operator overrides either env var.
const paymentProcessorQueueDepth = new client.Gauge({
  name: 'payment_processor_queue_depth',
  help: 'Number of in-flight payments currently held by the concurrent payment processor',
  registers: [registry],
  collect() {
    try {
      const { concurrentPaymentProcessor } = require('../services/concurrentPaymentProcessor');
      this.set(concurrentPaymentProcessor.getStats().queueDepth);
    } catch (_) {
      // Processor not loaded — scrape still succeeds
    }
  },
});

const paymentProcessorQueueHighWater = new client.Gauge({
  name: 'payment_processor_queue_backpressure_high_water',
  help: 'Configured high-water mark (QUEUE_BACKPRESSURE_HIGH_WATER) above which polling backpressure engages',
  registers: [registry],
  collect() {
    try {
      const config = require('../config');
      this.set(config.QUEUE_BACKPRESSURE_HIGH_WATER);
    } catch (_) {
      // Config not loaded — scrape still succeeds
    }
  },
});

const paymentProcessorQueueMaxDepth = new client.Gauge({
  name: 'payment_processor_queue_max_depth',
  help: 'Configured maximum queue depth (MAX_QUEUE_DEPTH) beyond which payments are rejected as QUEUE_FULL',
  registers: [registry],
  collect() {
    try {
      const config = require('../config');
      this.set(config.MAX_QUEUE_DEPTH);
    } catch (_) {
      // Config not loaded — scrape still succeeds
    }
  },
});

// backup_last_success_timestamp_seconds — Unix timestamp of the most recent
// successful backup. Updated by POST /api/internal/backup-heartbeat which
// backup.sh calls on success. Initialised to 0 (meaning "never recorded") so
// the BackupNotRun alert fires immediately when the process first starts and no
// heartbeat has arrived yet. See issue #1102.
const backupLastSuccessTimestamp = new client.Gauge({
  name: 'backup_last_success_timestamp_seconds',
  help: 'Unix timestamp of the most recent successful backup (0 = never recorded since process start)',
  registers: [registry],
});

// horizon_unreachable_since_seconds — Unix timestamp of the first Horizon
// poll failure in the current outage (0 = currently reachable). Set by
// transactionPollingService on first failure, cleared on first success. Lets
// the health check and alerting distinguish a transient blip from an outage
// that has persisted since startup. See issue #1340.
const horizonUnreachableSince = new client.Gauge({
  name: 'horizon_unreachable_since_seconds',
  help: 'Unix timestamp when Horizon first became unreachable in the current outage (0 = reachable)',
  registers: [registry],
});

// last_backup_verification_age_seconds — seconds since the most recent
// successful backup restore-verification (scripts/test-backup-recovery.sh),
// recorded via POST /api/internal/backup-verification-heartbeat. Recomputed
// fresh on every scrape (collect()) since it is an age, not a timestamp.
// A very large sentinel is reported before the first verification ever
// succeeds so the "not verified within 8 days" alert fires immediately.
// See issue #1343.
let _lastBackupVerificationSuccessAt = 0; // unix seconds; 0 = never recorded
const NEVER_VERIFIED_AGE_SECONDS = 30 * 24 * 3600; // sentinel: 30 days
const lastBackupVerificationAgeSeconds = new client.Gauge({
  name: 'last_backup_verification_age_seconds',
  help: 'Seconds since the last successful backup integrity verification (large sentinel if never verified)',
  registers: [registry],
  collect() {
    this.set(
      _lastBackupVerificationSuccessAt
        ? Math.floor(Date.now() / 1000) - _lastBackupVerificationSuccessAt
        : NEVER_VERIFIED_AGE_SECONDS
    );
  },
});

function recordBackupVerificationSuccess(timestampSeconds = Math.floor(Date.now() / 1000)) {
  _lastBackupVerificationSuccessAt = timestampSeconds;
}

module.exports = {
  registry,
  mongoConnectionState,
  mongoConnectionErrorsTotal,
  paymentProcessorQueueDepth,
  paymentProcessorQueueHighWater,
  paymentProcessorQueueMaxDepth,
  horizonPollBudgetRemaining,
  horizonPollBudgetCeiling,
  horizonPollDeferredSchools,
  horizonPollMaxDeferralCycles,
  horizonPollRequestsTotal,
  horizonRateLimitedTotal,
  syncDurationSeconds,
  httpRequestDurationSeconds,
  suspiciousPaymentFlagged,
  paymentLimitTriggeredTotal,
  paymentBatchTotal,
  paymentBatchItemsTotal,
  paymentBatchDurationSeconds,
  stuckPaymentsGauge,
  paymentFunnelTotal,
  horizonRequestDurationSeconds,
  webhookDeliveryTotal,
  notificationSentTotal,
  backupLastSuccessTimestamp,
  horizonUnreachableSince,
  lastBackupVerificationAgeSeconds,
  recordBackupVerificationSuccess,
};
