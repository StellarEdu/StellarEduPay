'use strict';

/**
 * Worker Heartbeat Registry
 *
 * Tracks the last-seen timestamp for each background worker. Each worker calls
 * `ping(name)` after completing a successful iteration. The health check reads
 * these timestamps and compares them against per-worker staleness thresholds.
 *
 * Design decisions:
 *  - In-memory: simple and sufficient for single-process deployments. For
 *    multi-replica deployments the per-process heartbeat is still useful as a
 *    "this process's workers are alive" check; cross-process liveness should
 *    be handled at the orchestration layer (k8s liveness probes).
 *  - No external dependency: heartbeats do not require Redis or MongoDB.
 *  - Zero-coupling: workers `require` this module and call `ping()`; the health
 *    endpoint reads state without any circular dependency.
 */

/**
 * Worker names — used as stable keys in both the heartbeat registry and the
 * health response payload. Add entries here when new background workers are
 * introduced.
 *
 * @enum {string}
 */
const WORKER_NAMES = {
  POLLING_SYNC:           'polling_sync',
  RETRY_WORKER:           'retry_worker',
  CONSISTENCY_SCHEDULER:  'consistency_scheduler',
  REMINDER_SCHEDULER:     'reminder_scheduler',
  TX_QUEUE_WORKER:        'tx_queue_worker',
  JOB_RECOVERY_SCHEDULER: 'job_recovery_scheduler',
};

/**
 * Expected maximum interval (ms) between heartbeats for each worker, plus an
 * optional grace period. A worker is considered stale when:
 *
 *   Date.now() - lastBeat > expectedIntervalMs + gracePeriodMs
 *
 * These thresholds must be larger than the worker's actual cycle time to avoid
 * false positives during momentarily slow iterations.
 *
 * All values are configurable via environment variables so operators can tune
 * them without code changes.
 */
const WORKER_CONFIG = {
  [WORKER_NAMES.POLLING_SYNC]: {
    expectedIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
    gracePeriodMs:      parseInt(process.env.WORKER_HEARTBEAT_GRACE_MS || '60000', 10),
  },
  [WORKER_NAMES.RETRY_WORKER]: {
    expectedIntervalMs: parseInt(process.env.RETRY_INTERVAL_MS || '60000', 10),
    gracePeriodMs:      parseInt(process.env.WORKER_HEARTBEAT_GRACE_MS || '60000', 10),
  },
  [WORKER_NAMES.CONSISTENCY_SCHEDULER]: {
    expectedIntervalMs: parseInt(process.env.CONSISTENCY_CHECK_INTERVAL_MS || '300000', 10),
    gracePeriodMs:      parseInt(process.env.WORKER_HEARTBEAT_GRACE_MS || '60000', 10),
  },
  [WORKER_NAMES.REMINDER_SCHEDULER]: {
    expectedIntervalMs: parseInt(process.env.REMINDER_INTERVAL_MS || '86400000', 10),
    gracePeriodMs:      parseInt(process.env.WORKER_HEARTBEAT_GRACE_MS || '120000', 10),
  },
  [WORKER_NAMES.TX_QUEUE_WORKER]: {
    // The queue worker processes jobs as they arrive; heartbeat on each
    // successful job completion. Use a generous threshold — a quiet queue
    // means the worker legitimately hasn't fired recently.
    expectedIntervalMs: parseInt(process.env.TX_QUEUE_HEARTBEAT_INTERVAL_MS || '300000', 10),
    gracePeriodMs:      parseInt(process.env.WORKER_HEARTBEAT_GRACE_MS || '120000', 10),
  },
  [WORKER_NAMES.JOB_RECOVERY_SCHEDULER]: {
    expectedIntervalMs: parseInt(process.env.JOB_RECOVERY_INTERVAL_MS || '60000', 10),
    gracePeriodMs:      parseInt(process.env.WORKER_HEARTBEAT_GRACE_MS || '60000', 10),
  },
};

/**
 * In-memory heartbeat store.
 * key: worker name string
 * value: { lastBeat: number (ms), startedAt: number (ms) | null }
 */
const _registry = new Map();

/**
 * Record a successful heartbeat for the named worker.
 * Call this after each completed iteration / processed job.
 *
 * @param {string} name - One of the WORKER_NAMES values.
 */
function ping(name) {
  const now = Date.now();
  const existing = _registry.get(name);
  _registry.set(name, {
    startedAt: existing?.startedAt ?? now,
    lastBeat: now,
  });
}

/**
 * Mark a worker as started (without recording a heartbeat yet).
 * Call this when the worker loop/scheduler is first initialised so the health
 * check knows the worker was requested to start, even before the first cycle
 * completes.
 *
 * @param {string} name
 */
function markStarted(name) {
  if (!_registry.has(name)) {
    _registry.set(name, { startedAt: Date.now(), lastBeat: null });
  }
}

/**
 * Remove a worker from the registry (called on graceful stop).
 *
 * @param {string} name
 */
function markStopped(name) {
  _registry.delete(name);
}

/**
 * Check liveness for all registered workers.
 *
 * Returns an object describing the health of each known worker, plus an overall
 * `allHealthy` flag.
 *
 * A worker is considered:
 *  - "not_started"  — never registered (markStarted / ping was never called).
 *  - "starting"     — registered (markStarted called) but no heartbeat yet AND
 *                     within the grace period.
 *  - "healthy"      — last heartbeat is within (expectedInterval + grace).
 *  - "stale"        — last heartbeat is older than (expectedInterval + grace).
 *
 * @returns {{ allHealthy: boolean, workers: Object.<string, WorkerStatus> }}
 */
function checkLiveness() {
  const now = Date.now();
  const workers = {};
  let allHealthy = true;

  for (const [name, cfg] of Object.entries(WORKER_CONFIG)) {
    const entry = _registry.get(name);
    const threshold = cfg.expectedIntervalMs + cfg.gracePeriodMs;

    if (!entry) {
      // Never started — only report as unhealthy if other workers have started
      // (i.e. the process has passed startup). We defer this judgment to the
      // caller; here we just report the raw state.
      workers[name] = {
        status: 'not_started',
        lastBeatMs: null,
        startedAt: null,
        thresholdMs: threshold,
      };
      allHealthy = false;
      continue;
    }

    const { lastBeat, startedAt } = entry;

    if (lastBeat === null) {
      // Started but no beat yet — give it the grace period from start time.
      const age = now - startedAt;
      if (age < cfg.gracePeriodMs) {
        workers[name] = {
          status: 'starting',
          lastBeatMs: null,
          startedAt,
          thresholdMs: threshold,
        };
        // Starting is OK — not yet stale.
      } else {
        workers[name] = {
          status: 'stale',
          lastBeatMs: null,
          startedAt,
          thresholdMs: threshold,
          staleByMs: age - cfg.gracePeriodMs,
        };
        allHealthy = false;
      }
      continue;
    }

    const age = now - lastBeat;
    if (age > threshold) {
      workers[name] = {
        status: 'stale',
        lastBeatMs: lastBeat,
        startedAt,
        thresholdMs: threshold,
        staleByMs: age - threshold,
      };
      allHealthy = false;
    } else {
      workers[name] = {
        status: 'healthy',
        lastBeatMs: lastBeat,
        startedAt,
        thresholdMs: threshold,
      };
    }
  }

  return { allHealthy, workers };
}

/**
 * Reset the registry (used in tests only).
 */
function _reset() {
  _registry.clear();
}

module.exports = {
  WORKER_NAMES,
  WORKER_CONFIG,
  ping,
  markStarted,
  markStopped,
  checkLiveness,
  _reset,
};
