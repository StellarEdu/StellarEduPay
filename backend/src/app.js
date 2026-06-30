'use strict';

require('dotenv').config();
const config = require('./config');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

// ── Suppress verbose third-party logging in development ──────────────────────
// Prevent noise from ioredis reconnect attempts, Mongoose debug info, etc.
// when LOG_LEVEL=info (the development default).
if (process.env.NODE_ENV !== 'production') {
  // Suppress ioredis verbose logging (connection/reconnection attempts)
  const redisDebug = require('debug');
  redisDebug.disable('*');
  
  // Suppress Mongoose debug output
  mongoose.set('debug', false);
}

const studentRoutes = require('./routes/studentRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const feeRoutes = require('./routes/feeRoutes');
const reportRoutes = require('./routes/reportRoutes');
const schoolRoutes = require('./routes/schoolRoutes');
const reminderRoutes = require('./routes/reminderRoutes');
const disputeRoutes = require('./routes/disputeRoutes');
const sourceValidationRuleRoutes = require('./routes/sourceValidationRuleRoutes');
const receiptsRoutes = require('./routes/receiptsRoutes');
const feeAdjustmentRoutes = require('./routes/feeAdjustmentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const metricsRoute = require('./routes/metricsRoute');

const { registerPaymentSavedSubscribers } = require('./services/paymentSavedSubscribers');
const { startPolling, stopPolling } = require('./services/transactionPollingService');
const retrySelector = require('./services/retryServiceSelector');
const { startConsistencyScheduler, stopConsistencyScheduler } = require('./services/consistencyScheduler');
const { startReminderScheduler, stopReminderScheduler } = require('./services/reminderService');
const { startWorker: startTxQueueWorker, stopWorker: stopTxQueueWorker } = require('./services/transactionQueueService');
const { startSessionCleanupScheduler, stopSessionCleanupScheduler } = require('./services/sessionCleanupService');
const { startReconciliationScheduler, stopReconciliationScheduler } = require('./services/reconciliationService');
const { startStuckPaymentReconciliationScheduler, stopStuckPaymentReconciliationScheduler } = require('./services/stuckPaymentReconciliation');
const { startAuditLogCleanupScheduler, stopAuditLogCleanupScheduler } = require('./services/auditLogCleanupService');
const { startMetricsRollupScheduler, stopMetricsRollupScheduler } = require('./services/metricsRollupService');
const { startWebhookRetryScheduler, stopWebhookRetryScheduler } = require('./services/webhookRetryScheduler');
const { startOutboxDispatcher, stopOutboxDispatcher } = require('./services/outboxDispatcher');
const { startReconciliationReportScheduler, stopReconciliationReportScheduler } = require('./services/reconciliationReportScheduler');
const { closeQueue } = require('./queue/transactionQueue');
const bullMQRetryService = require('./services/bullMQRetryService');
const { initializeRetryQueue, setupMonitoring } = require('./config/retryQueueSetup');
const { notFoundHandler, globalErrorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');
const { createConcurrentRequestMiddleware } = require('./middleware/concurrentRequestHandler');
const { requireAdminAuth } = require('./middleware/auth');
const { jsonDepthGuard, deduplicateQueryParams } = require('./middleware/sanitizeRequest');
const { runConsistencyCheck } = require('./controllers/consistencyController');
const { healthCheck, healthLive, healthReady } = require('./controllers/healthController');
const logger = require('./utils/logger');
const { startHeapMonitoring } = require('./utils/heapMonitoring');

const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const { parseAllowedOrigins } = require('./utils/corsOrigins');

const allowedOrigins = parseAllowedOrigins();

const app = express();

// Trust the number of proxy hops configured via TRUSTED_PROXY_HOPS (default: 1).
// This ensures Express derives req.ip from the correct X-Forwarded-For entry
// rather than trusting client-supplied headers, which would allow rate-limit bypass.
app.set('trust proxy', parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-School-ID', 'Idempotency-Key'],
  credentials: true,
}));
app.use(cookieParser());
// The backend serves only JSON API responses — no HTML, scripts, or styles.
// CSP directives for HTML content (scriptSrc, styleSrc, imgSrc, etc.) are
// irrelevant here and have been removed. The frontend (Next.js) owns those.
// We keep only the directives that are meaningful for an API endpoint.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(express.json({ limit: config.MAX_BODY_SIZE }));
app.use(requestLogger());

// ── Cache-Control: no-store on auth and sensitive data routes ─────────────────
// Prevents intermediaries (CDNs, shared proxies) from caching tokens,
// payment data, audit logs, and other sensitive JSON responses.
const SENSITIVE_PATH_RE = /^\/api\/(auth|payments|students|reports|audit|receipts|disputes|fee-adjustments|payment-plans|reminders)\b/;
app.use((req, res, next) => {
  if (SENSITIVE_PATH_RE.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// ── JSON depth / array-bomb guard + query-param de-pollution ──────────────────
app.use(jsonDepthGuard);
app.use(deduplicateQueryParams);

const concurrentMiddleware = createConcurrentRequestMiddleware({
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, halfOpenSuccessThreshold: 2 },
  queue: { maxConcurrent: 50, maxSize: 1000, defaultTimeoutMs: 30000 },
  rateLimit: { windowMs: 60000, maxRequests: 100 },
  deduplicationTtlMs: 60000,
});
// ── Metrics ───────────────────────────────────────────────────────────────────
// Mounted before the rate-limiter so Prometheus scrapes are never throttled.
app.use('/metrics', metricsRoute);

app.use(concurrentMiddleware.rateLimiter((req) => req.ip));
app.use(concurrentMiddleware.requestQueue());

// ── Maintenance mode ───────────────────────────────────────────────────────────
// Global maintenance mode check. Per-school maintenance mode is enforced inside
// schoolContext.js after tenant resolution.
const { maintenanceMode } = require('./middleware/maintenanceMode');
app.use(maintenanceMode);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/schools', schoolRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/source-rules', sourceValidationRuleRoutes);
app.use('/api/receipts', receiptsRoutes);
app.use('/api/fee-adjustments', feeAdjustmentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.get('/api/consistency', requireAdminAuth, runConsistencyCheck);
app.get('/health', healthCheck);
app.get('/health/live', healthLive);
app.get('/health/ready', healthReady);

// Issue #671: OpenAPI/Swagger documentation
try {
  const swaggerSpecs = require('./config/swagger');
  app.get('/api/docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpecs);
  });

  // Swagger UI (development only)
  if (process.env.NODE_ENV !== 'production') {
    const swaggerUi = require('swagger-ui-express');
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, {
      swaggerOptions: {
        url: '/api/docs.json',
      },
    }));
  }
} catch (err) {
  logger.warn('Swagger documentation not available', { error: err.message });
}

// ── Error handling ────────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ── Database + service startup ────────────────────────────────────────────────
async function connectWithRetry(maxAttempts = 5, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mongoose.connect(config.MONGO_URI);
      logger.info('MongoDB connected');
      return;
    } catch (err) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1); // exponential backoff
      logger.error(`MongoDB connection attempt ${attempt}/${maxAttempts} failed`, {
        error: err.message,
        retryInMs: attempt < maxAttempts ? delay : null,
      });
      if (attempt === maxAttempts) {
        logger.error('Exhausted all MongoDB connection attempts — exiting');
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Log disconnections after successful startup
mongoose.connection.on('disconnected', () =>
  logger.warn('MongoDB disconnected — waiting for reconnect')
);
mongoose.connection.on('reconnected', () =>
  logger.info('MongoDB reconnected')
);
mongoose.connection.on('error', (err) =>
  logger.error('MongoDB connection error', { error: err.message })
);

connectWithRetry().then(async () => {
  // Start heap monitoring to detect memory leaks early
  startHeapMonitoring();

  // Seed default system config entries on first run
  const SystemConfig = require('./models/systemConfigModel');
  const DEFAULTS = [
    { key: 'maintenanceMode',    value: false },
    { key: 'maxSyncBatchSize',   value: 20 },
    { key: 'reminderEnabled',    value: true },
    { key: 'reminderIntervalMs', value: 86400000 },
  ];
  await Promise.all(
    DEFAULTS.map(({ key, value }) =>
      SystemConfig.findOneAndUpdate({ key }, { $setOnInsert: { key, value } }, { upsert: true })
    )
  );
  logger.info('System config defaults ensured');

  // Reconcile stuck payments on startup
  const { reconcileStuckPayments } = require('./services/stuckPaymentReconciliation');
  try {
    await reconcileStuckPayments();
  } catch (err) {
    logger.error('Stuck payment reconciliation failed on startup', { error: err.message });
  }

  // Recover any pending/processing BullMQ jobs that survived a restart in MongoDB
  const { recoverPendingJobs } = require('./queue/transactionQueue');
  try {
    await recoverPendingJobs();
  } catch (err) {
    logger.error('Transaction queue recovery failed on startup', { error: err.message });
  }

  // ── Leader election for singleton schedulers ───────────────────────────────
  // Polling uses per-school distributed locks; the transaction queue worker
  // and retry selector are safe for multi-instance.  All other schedulers run
  // only on the elected leader to prevent N× concurrent execution when scaled.
  const leaderElection = require('./services/leaderElection');

  const startLeaderSchedulers = () => {
    logger.info('[Leader] Starting leader-only schedulers');
    startConsistencyScheduler();
    startReminderScheduler();
    startSessionCleanupScheduler();
    startReconciliationScheduler();
    startStuckPaymentReconciliationScheduler();
    startAuditLogCleanupScheduler();
    startWebhookRetryScheduler();
    startReconciliationReportScheduler();
    startMetricsRollupScheduler();
  };

  const stopLeaderSchedulers = () => {
    logger.info('[Leader] Stopping leader-only schedulers');
    stopConsistencyScheduler();
    stopReminderScheduler();
    stopSessionCleanupScheduler();
    stopReconciliationScheduler();
    stopStuckPaymentReconciliationScheduler();
    stopAuditLogCleanupScheduler();
    stopWebhookRetryScheduler();
    stopReconciliationReportScheduler();
    stopMetricsRollupScheduler();
  };

  leaderElection.register(startLeaderSchedulers, stopLeaderSchedulers);
  await leaderElection.start();

  // Always-start services (handle concurrency internally)
  startPolling();
  retrySelector.start();
  startTxQueueWorker();
  registerPaymentSavedSubscribers();
  startOutboxDispatcher();

  // Only initialise BullMQ when Redis is configured
  if (retrySelector.useBullMQ()) {
    try {
      await initializeRetryQueue(app);
      setupMonitoring(60000);
      logger.info('All services initialized successfully');
    } catch (error) {
      // The HTTP server still boots, but the retry/dead-letter pipeline is dead —
      // failed payments would silently never be retried. Fail loudly so the broken
      // state is visible in logs and via /health (retryQueue.status: failed).
      logger.error(
        '[CRITICAL] Retry queue failed to initialize — failed payments will NOT be retried. ' +
        'Investigate Redis/BullMQ connection immediately.',
        { error: error.message }
      );
    }
  } else {
    logger.warn('REDIS_HOST is not configured — using MongoDB retry backend. Rate-limit counters are in-process only and will reset on restart. Set REDIS_HOST for production deployments.');
    logger.info('All services initialized successfully (MongoDB retry backend)');
  }
});

// ── Server ────────────────────────────────────────────────────────────────────
const PORT = config.PORT;
const server = require.main === module
  ? app.listen(PORT, () => logger.info(`Server running on port ${PORT}`))
  : { close: (cb) => cb && cb() };

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`Received ${signal} signal — starting graceful shutdown`);

  const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30_000;

  // Stop background services — no new work accepted
  stopPolling();
  retrySelector.stop();

  // Stop leader election (demotes leader, stops leader-only schedulers)
  try {
    const leaderElection = require('./services/leaderElection');
    await leaderElection.stop();
  } catch (_) { /* leader election may not have been started */ }

  try {
    await stopTxQueueWorker();
    await closeQueue();
    await bullMQRetryService.shutdownQueue();
    await require('./services/sseService').close();
    await require('./services/distributedLock').close();
    await require('./services/schoolCacheInvalidator').close();
    logger.info('BullMQ resources closed cleanly');
  } catch (err) {
    logger.error('Error closing BullMQ resources during shutdown', { error: err.message });
  }

  // Force exit after SHUTDOWN_TIMEOUT_MS regardless of in-flight requests
  const forceExitTimer = setTimeout(() => {
    logger.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms shutdown timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref(); // don't keep the event loop alive just for this timer

  // (1) Stop accepting new connections; (2) wait for in-flight requests to finish;
  // (3) only then close the database connection.
  server.close(async () => {
    try {
      await mongoose.disconnect();
      logger.info('MongoDB disconnected — clean exit');
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      logger.error('Error closing MongoDB', { error: err.message });
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
