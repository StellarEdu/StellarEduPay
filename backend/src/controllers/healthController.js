'use strict';

const database = require('../config/database');
const { horizonClient, CB_FAILURE_THRESHOLD, CB_RESET_TIMEOUT_MS, CB_HALF_OPEN_SUCCESS_THRESHOLD } = require('../config/stellarConfig');
const config = require('../config');
const { getReminderStatus } = require('../services/reminderService');
const { getCachedRates } = require('../services/currencyConversionService');
const { getAuditHealth } = require('../services/auditService');
const { getRedisStatus } = require('../config/redisClient');
const { checkLiveness, WORKER_NAMES } = require('../services/workerHeartbeat');
const { getRecoveryStatus } = require('../queue/transactionQueue');
const logger = require('../utils/logger');
const { isReady: isShutdownReady } = require('../services/shutdownManager');
const { isEncryptionEnabled: isPiiEncryptionEnabled } = require('../services/studentPiiEncryption');
const { isEncryptionEnabled: isWebhookSecretEncryptionEnabled } = require('../services/webhookSecretEncryption');
const { getBuildInfo } = require('../utils/buildInfo');

const STELLAR_CHECK_TIMEOUT_MS = 3000; // 3 second timeout for Stellar health check

/**
 * Report whether at-rest encryption is active for PII and webhook secrets.
 * Both services silently no-op without a key, so this is the only way an
 * operator can tell whether data is actually being encrypted (#1778).
 *
 * @returns {{pii: boolean, webhookSecrets: boolean}}
 */
function getEncryptionStatus() {
  return {
    pii: Boolean(isPiiEncryptionEnabled()),
    webhookSecrets: Boolean(isWebhookSecretEncryptionEnabled()),
  };
}

let encryptionStatusLogged = false;

/**
 * Log the encryption status once at boot so operators can see whether PII and
 * webhook secrets are being encrypted (#1778). Safe to call more than once.
 */
function logEncryptionStatusOnce() {
  if (encryptionStatusLogged) return;
  encryptionStatusLogged = true;
  const status = getEncryptionStatus();
  if (status.pii && status.webhookSecrets) {
    logger.info('At-rest encryption enabled', status);
  } else {
    logger.warn('At-rest encryption is NOT fully enabled — data may be stored in plaintext', status);
  }
}

/**
 * Map a raw dependency error to a stable, non-sensitive reason code (#1540).
 *
 * Raw error strings frequently include hostnames, ports and driver internals
 * (e.g. "getaddrinfo ENOTFOUND mongo-0.mongo.svc"), so they are logged
 * server-side and never returned in an HTTP response.
 *
 * @param {string|null|undefined} message
 * @returns {string|null}
 */
function toReasonCode(message) {
  if (!message) return null;
  const m = String(message);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'DNS_RESOLUTION_FAILED';
  if (/ECONNREFUSED/i.test(m)) return 'CONNECTION_REFUSED';
  if (/ECONNRESET|socket hang up/i.test(m)) return 'CONNECTION_RESET';
  if (/timed? ?out|ETIMEDOUT|did not respond within/i.test(m)) return 'TIMEOUT';
  if (/circuit/i.test(m)) return 'CIRCUIT_OPEN';
  if (/auth|NOAUTH|WRONGPASS|unauthori[sz]ed|forbidden/i.test(m)) return 'AUTH_FAILED';
  if (/not (yet )?connected|disconnected|readyState/i.test(m)) return 'NOT_CONNECTED';
  return 'UNAVAILABLE';
}

/**
 * Log a dependency failure with its raw message (server-side only) and return
 * the reason code to expose instead.
 */
function reasonFor(dependency, message) {
  const code = toReasonCode(message);
  if (code) logger.warn('Health check dependency failure', { dependency, reason: code, error: String(message) });
  return code;
}

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

/**
 * Collect the full health report. Returns the HTTP status code and the
 * detailed body served (behind admin auth) by GET /api/admin/health/details.
 * Raw error messages are replaced with stable reason codes (#1540).
 *
 * @returns {Promise<{statusCode: number, body: object}>}
 */
async function buildHealthReport() {
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

  // If the background poller has had Horizon unreachable for longer than its
  // own max backoff window, no payments have synced since startup or the
  // outage began — surface that explicitly rather than letting a healthy DB
  // mask it. See issue #1340.
  const POLL_MAX_BACKOFF_MS = parseInt(process.env.POLL_MAX_BACKOFF_MS || '300000', 10);
  const { getHorizonUnreachableSince } = require('../services/transactionPollingService');
  const horizonUnreachableSinceMs = getHorizonUnreachableSince();
  const horizonUnreachableTooLong =
    horizonUnreachableSinceMs !== null && Date.now() - horizonUnreachableSinceMs > POLL_MAX_BACKOFF_MS;

  if (db.healthy !== true) {
    overallStatus = 'unhealthy';
    statusCode = 503;
  } else if (redisConfigured && redisStatus.status !== 'ready') {
    overallStatus = 'degraded';
    statusCode = 200;
  } else if (stellar.status !== 'ok' || horizonUnreachableTooLong) {
    overallStatus = 'degraded';
    statusCode = 200; // Still return 200 since DB is up and cached data can be served
  }

  // concurrentPaymentProcessor was removed (#1036) and its removal completed in
  // #1275: no module emits payment-processor queue stats any more, so there is
  // nothing to read here. This explicit zero fallback mirrors the one in
  // transactionPollingService.js#getQueueBackpressureState() so the health
  // payload and the polling backpressure path always agree.
  const queueDepth = 0;
  const maxQueueDepth = config.MAX_QUEUE_DEPTH;

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

  // Pending-job recovery degraded (#1381): Redis wasn't ready within the
  // startup retry budget, so jobs that survived a restart are still sitting in
  // MongoDB. Not unhealthy — the periodic jobRecoveryScheduler will drain them
  // as soon as Redis reconnects — but worth surfacing so on-call can see it.
  const jobRecovery = getRecoveryStatus();
  if (jobRecovery.status === 'degraded' && overallStatus === 'healthy') {
    overallStatus = 'degraded';
  }

  // Worker liveness check — any stale/not_started worker triggers 503 so
  // orchestrators can restart the pod. "starting" is healthy (within grace).
  const workerLiveness = checkLiveness();
  if (!workerLiveness.allHealthy && overallStatus !== 'unhealthy') {
    overallStatus = 'unhealthy';
    statusCode = 503;
  }

  // BullMQ transaction queue worker heartbeat — a silently crashed worker stops
  // payment processing without tripping the generic staleness check above (whose
  // threshold is tuned for a quiet queue). Degrade/alert sooner based directly on
  // POLL_INTERVAL_MS so on-call is paged before parents notice stuck payments.
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
  const txQueueWorker = workerLiveness.workers[WORKER_NAMES.TX_QUEUE_WORKER];
  const txQueueHeartbeatAgeMs =
    txQueueWorker?.lastBeatMs != null ? Date.now() - txQueueWorker.lastBeatMs : null;

  if (txQueueHeartbeatAgeMs !== null) {
    if (txQueueHeartbeatAgeMs > pollIntervalMs * 5) {
      overallStatus = 'unhealthy';
      statusCode = 503;
    } else if (txQueueHeartbeatAgeMs > pollIntervalMs * 2 && overallStatus === 'healthy') {
      overallStatus = 'degraded';
    }
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
        ...(db.reason && { reason: reasonFor('database', db.reason) }),
      },
      stellar: {
        status: stellar.status,
        ...(stellar.latencyMs !== undefined && { latency_ms: stellar.latencyMs }),
        ...(stellar.error && { reason: reasonFor('stellar', stellar.error) }),
        network: config.STELLAR_NETWORK,
        horizonUrl: stellar.activeUrl || config.HORIZON_URL,
        activeEndpoint: stellar.activeUrl || config.HORIZON_URL,
        endpoints: stellar.endpoints || [],
        circuitBreaker: {
          failureThreshold: CB_FAILURE_THRESHOLD,
          resetTimeoutMs: CB_RESET_TIMEOUT_MS,
          halfOpenSuccessThreshold: CB_HALF_OPEN_SUCCESS_THRESHOLD,
        },
        ...(horizonUnreachableSinceMs !== null && {
          horizonUnreachableSince: new Date(horizonUnreachableSinceMs).toISOString(),
        }),
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
        ...(redisStatus.reason && { reason: reasonFor('redis', redisStatus.reason) }),
        ...(redisStatus.lastUpdatedAt && { lastUpdatedAt: redisStatus.lastUpdatedAt }),
      },
      priceFeed: {
        available: priceFeedStatus.length > 0,
        rates: priceFeedStatus,
      },
      auditLog: getAuditHealth(),
      encryption: getEncryptionStatus(),
      jobRecovery: (() => {
        const { lastError, ...rest } = jobRecovery;
        return { ...rest, ...(lastError && { reason: reasonFor('jobRecovery', lastError) }) };
      })(),
      workers: {
        healthy: workerLiveness.allHealthy,
        detail: workerLiveness.workers,
        transactionQueueWorker: {
          heartbeatAgeMs: txQueueHeartbeatAgeMs,
          degradedThresholdMs: pollIntervalMs * 2,
          unhealthyThresholdMs: pollIntervalMs * 5,
        },
      },
    },
  };

  return { statusCode, body };
}

/**
 * GET /health — public, unauthenticated (#1540).
 *
 * Returns only { status } with HTTP 200 (healthy/degraded) or 503 (unhealthy)
 * so load balancers and uptime checks keep working without disclosing
 * hostnames, Horizon endpoints, error strings, queue depths or worker state.
 * The detailed report is served by GET /api/admin/health/details.
 */
async function healthCheck(req, res) {
  try {
    const { statusCode, body } = await buildHealthReport();
    return res.status(statusCode).json({ status: body.status });
  } catch (err) {
    logger.error('Health check failed', { error: err.message });
    return res.status(503).json({ status: 'unhealthy' });
  }
}

/**
 * GET /api/admin/health/details — admin-authenticated detailed diagnostics (#1540).
 */
async function healthDetails(req, res) {
  try {
    const { statusCode, body } = await buildHealthReport();
    return res.status(statusCode).json(body);
  } catch (err) {
    logger.error('Health details failed', { error: err.message });
    return res.status(503).json({ status: 'unhealthy', reason: toReasonCode(err.message) });
  }
}

/**
 * GET /health/live
 * Liveness probe: returns 200 if the process is running and responsive.
 * No external dependency checks — if this fails, the container should restart.
 */
async function healthLive(req, res) {
  const { version, commit } = getBuildInfo();
  return res.status(200).json({ status: 'alive', version, commit, timestamp: new Date().toISOString() });
}

/**
 * GET /api/version
 * Reports which release this process is running (#1634) so operators can
 * tell deployments apart and integrators can track API changes.
 */
async function version(req, res) {
  return res.status(200).json(getBuildInfo());
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

  // #1540: this probe is unauthenticated — expose per-dependency status and a
  // stable reason code only (no Horizon URLs, hostnames or raw errors).
  return res.status(statusCode).json({
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks: {
      database: {
        status: db.healthy ? 'healthy' : 'unhealthy',
        ...(db.reason && { reason: reasonFor('database', db.reason) }),
      },
      stellar: {
        status: stellar.status,
        ...(stellar.error && { reason: reasonFor('stellar', stellar.error) }),
      },
    },
  });
}

module.exports = {
  healthCheck,
  healthDetails,
  healthLive,
  healthReady,
  version,
  buildHealthReport,
  toReasonCode,
  getEncryptionStatus,
  logEncryptionStatusOnce,
};
