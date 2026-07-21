'use strict';

const database = require('../config/database');
const { horizonClient, CB_FAILURE_THRESHOLD, CB_RESET_TIMEOUT_MS, CB_HALF_OPEN_SUCCESS_THRESHOLD } = require('../config/stellarConfig');
const config = require('../config');
const { concurrentPaymentProcessor } = require('../services/concurrentPaymentProcessor');
const { getReminderStatus } = require('../services/reminderService');
const { getCachedRates } = require('../services/currencyConversionService');
const { getAuditHealth } = require('../services/auditService');
const { getRedisStatus } = require('../config/redisClient');
const logger = require('../utils/logger');
const { isReady: isShutdownReady } = require('../services/shutdownManager');

const STELLAR_CHECK_TIMEOUT_MS = 3000; // 3 second timeout for Stellar health check

async function checkStellar() {
  const start = Date.now();
  let timeoutHandle;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Horizon did not respond within ${STELLAR_CHECK_TIMEOUT_MS}ms`)),
        STELLAR_CHECK_TIMEOUT_MS
      );
      // Don't let this probe timer keep the event loop (or a test runner) alive.
      if (timeoutHandle.unref) timeoutHandle.unref();
    });
    // Use horizonClient.call() so the health probe itself benefits from failover
    await Promise.race([
      horizonClient.call((server) => server.ledgers().limit(1).call()),
      timeoutPromise,
    ]);
    return {
      status: 'ok',
      latencyMs: Date.now() - start,
      activeUrl: horizonClient.activeUrl,
      endpoints: horizonClient.getCircuitBreakerStatus(),
    };
  } catch (err) {
    return {
      status: 'unreachable',
      error: err.message,
      latencyMs: Date.now() - start,
      activeUrl: horizonClient.activeUrl,
      endpoints: horizonClient.getCircuitBreakerStatus(),
    };
  } finally {
    // Always clear the probe timeout so it can't reject after the race has
    // already settled (which would surface as an unhandled rejection later).
    clearTimeout(timeoutHandle);
  }
}

async function healthCheck(req, res) {
  const [dbResult, stellarResult] = await Promise.allSettled([
    database.healthCheck(),
    checkStellar(),
  ]);

  const db =
    dbResult.status === 'fulfilled'
      ? dbResult.value
      : { healthy: false, reason: dbResult.reason?.message };

  const stellar =
    stellarResult.status === 'fulfilled'
      ? stellarResult.value
      : { status: 'unreachable', error: stellarResult.reason?.message };

  const retrySelector = require('../services/retryServiceSelector');
  const retryBackend = retrySelector.getSelectedBackend();
  const redisStatus = getRedisStatus();
  const redisConfigured = Boolean(redisStatus.configured);

  let overallStatus = 'healthy';
  let statusCode = 200;

  if (db.healthy !== true) {
    overallStatus = 'unhealthy';
    statusCode = 503;
  } else if (redisConfigured && redisStatus.status !== 'ready') {
    overallStatus = 'degraded';
    statusCode = 200;
  } else if (stellar.status !== 'ok') {
    overallStatus = 'degraded';
    statusCode = 200; // Still return 200 since DB is up and cached data can be served
  }

  const { queueDepth, maxQueueDepth } = concurrentPaymentProcessor.getStats();

  // Retry queue init status. For the Redis-backed BullMQ pipeline this reflects
  // whether initializeRetryQueue() succeeded; for the MongoDB fallback it reflects
  // whether the worker is running.
  let retryQueueStatus;
  if (retryBackend === 'bullmq') {
    const { getRetryQueueHealth } = require('../config/retryQueueSetup');
    retryQueueStatus = getRetryQueueHealth().status; // 'ok' | 'failed' | 'not_started'
  } else if (retryBackend === 'mongodb') {
    retryQueueStatus = retrySelector.isRunning() ? 'ok' : 'stopped';
  } else {
    retryQueueStatus = 'not_started';
  }

  // A dead retry/dead-letter pipeline means failed payments are never retried —
  // surface that as degraded (DB is still up, so not fully unhealthy).
  if (retryQueueStatus === 'failed' && overallStatus === 'healthy') {
    overallStatus = 'degraded';
  }

  // Price feed status
  const cachedRates = getCachedRates();
  const priceFeedStatus = Object.entries(cachedRates).map(([currency, data]) => {
    const staleAge = data.lastSuccessfulFetch
      ? Math.floor((Date.now() - new Date(data.lastSuccessfulFetch).getTime()) / 1000)
      : null;
    return {
      currency,
      available: true,
      lastFetchedAt: data.lastSuccessfulFetch || data.fetchedAt,
      staleAge,
    };
  });

  const body = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    logLevel: logger.getLevel(),
    checks: {
      database: {
        status: db.healthy ? 'healthy' : 'unhealthy',
        ...(db.latency !== undefined && { latency_ms: db.latency }),
        ...(db.readyState !== undefined && { readyState: db.readyState }),
        ...(db.reason && { error: db.reason }),
      },
      stellar: {
        status: stellar.status,
        ...(stellar.latencyMs !== undefined && { latency_ms: stellar.latencyMs }),
        ...(stellar.error && { error: stellar.error }),
        network: config.STELLAR_NETWORK,
        horizonUrl: stellar.activeUrl || config.HORIZON_URL,
        activeEndpoint: stellar.activeUrl || config.HORIZON_URL,
        endpoints: stellar.endpoints || [],
        circuitBreaker: {
          failureThreshold: CB_FAILURE_THRESHOLD,
          resetTimeoutMs: CB_RESET_TIMEOUT_MS,
          halfOpenSuccessThreshold: CB_HALF_OPEN_SUCCESS_THRESHOLD,
        },
      },
      paymentProcessor: {
        queueDepth,
        maxQueueDepth,
      },
      reminders: getReminderStatus(),
      retryQueue: {
        status: retryQueueStatus,
        backend: retryBackend || 'not_started',
        redisConfigured,
        redisStatus: redisStatus.status,
        ...(redisConfigured && { redisHost: process.env.REDIS_HOST }),
        ...(redisStatus.reason && { error: redisStatus.reason }),
        ...(redisStatus.lastUpdatedAt && { lastUpdatedAt: redisStatus.lastUpdatedAt }),
      },
      priceFeed: {
        available: priceFeedStatus.length > 0,
        rates: priceFeedStatus,
      },
      auditLog: getAuditHealth(),
    },
  };

  return res.status(statusCode).json(body);
}

/**
 * GET /health/live
 * Liveness probe: returns 200 if the process is running and responsive.
 * No external dependency checks — if this fails, the container should restart.
 */
async function healthLive(req, res) {
  return res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
}

/**
 * GET /health/ready
 * Readiness probe: returns 200 only when the service can handle traffic.
 * Checks DB, Horizon, and shutdown readiness; returns 503 if any is unavailable.
 */
async function healthReady(req, res) {
  // Check if shutdown has started (readiness flag flipped)
  if (!isShutdownReady()) {
    return res.status(503).json({
      status: 'not_ready',
      reason: 'shutdown_in_progress',
      timestamp: new Date().toISOString(),
    });
  }

  const [dbResult, stellarResult] = await Promise.allSettled([
    database.healthCheck(),
    checkStellar(),
  ]);

  const db =
    dbResult.status === 'fulfilled'
      ? dbResult.value
      : { healthy: false, reason: dbResult.reason?.message };

  const stellar =
    stellarResult.status === 'fulfilled'
      ? stellarResult.value
      : { status: 'unreachable', error: stellarResult.reason?.message };

  const ready = db.healthy === true && stellar.status === 'ok';
  const statusCode = ready ? 200 : 503;

  return res.status(statusCode).json({
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks: {
      database: { status: db.healthy ? 'healthy' : 'unhealthy', ...(db.reason && { error: db.reason }) },
      stellar: {
        status: stellar.status,
        activeEndpoint: stellar.activeUrl || config.HORIZON_URL,
        endpoints: stellar.endpoints || [],
        ...(stellar.error && { error: stellar.error }),
      },
    },
  });
}

module.exports = { healthCheck, healthLive, healthReady };
