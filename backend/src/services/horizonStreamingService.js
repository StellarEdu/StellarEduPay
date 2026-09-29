'use strict';

/**
 * Horizon Streaming Service (Issue #1570)
 *
 * Replaces interval-based polling with Stellar Horizon SSE streams so that
 * payments are detected within seconds of ledger close rather than up to one
 * full poll interval later.
 *
 * Architecture
 * ─────────────
 *   • One persistent SSE stream per active school wallet
 *     (`/accounts/{address}/transactions?cursor={syncCursor}&order=asc`).
 *   • Each stream message is forwarded to the existing `processTransaction`
 *     function, preserving all idempotency, validation, and recording logic.
 *   • The syncCursor is persisted to MongoDB after every processed message so
 *     reconnects resume exactly where the stream left off.
 *   • Reconnect with capped exponential backoff (1 s → 64 s) when a stream
 *     disconnects or errors.
 *   • A low-frequency safety-net poll (STREAM_SAFETY_NET_INTERVAL_MS, default
 *     10 minutes) runs via transactionPollingService to fill any gaps that
 *     might occur during a reconnect window.
 *   • Schools that become inactive or are deleted have their streams torn down.
 *   • Prometheus gauges: horizon_streams_open, horizon_stream_reconnects_total,
 *     horizon_stream_lag_seconds.
 *
 * Environment variables
 * ─────────────────────
 *   HORIZON_STREAMING_ENABLED        Set to 'false' to disable (default: 'true').
 *   STREAM_RECONNECT_INITIAL_MS      Initial backoff after error (default: 1000).
 *   STREAM_RECONNECT_MAX_MS          Max backoff cap (default: 64000).
 *   STREAM_SAFETY_NET_INTERVAL_MS    Safety-net full poll interval ms (default: 600000 = 10 min).
 *   STREAM_SCHOOLS_REFRESH_MS        How often to reconcile active school list (default: 60000).
 */

const School = require('../models/schoolModel');
const { processTransaction } = require('./transactionPollingService');
const { server: defaultServer } = require('../config/stellarConfig');
const logger = require('../utils/logger').child('HorizonStreamingService');

// ── Configuration ─────────────────────────────────────────────────────────────
const STREAMING_ENABLED = process.env.HORIZON_STREAMING_ENABLED !== 'false';
const RECONNECT_INITIAL_MS = parseInt(process.env.STREAM_RECONNECT_INITIAL_MS || '1000', 10);
const RECONNECT_MAX_MS = parseInt(process.env.STREAM_RECONNECT_MAX_MS || '64000', 10);
const SAFETY_NET_INTERVAL_MS = parseInt(process.env.STREAM_SAFETY_NET_INTERVAL_MS || '600000', 10);
const SCHOOLS_REFRESH_MS = parseInt(process.env.STREAM_SCHOOLS_REFRESH_MS || '60000', 10);

// ── Prometheus metrics (lazily registered) ────────────────────────────────────
let _streamsOpen;
let _streamReconnectsTotal;
let _streamLag;

function _ensureMetrics() {
  let metrics;
  try { metrics = require('../metrics'); } catch (_) { return; }
  if (!metrics) return;
  const { registry } = metrics;
  const client = require('prom-client');

  if (!_streamsOpen) {
    _streamsOpen = new client.Gauge({
      name: 'horizon_streams_open',
      help: 'Number of currently open Horizon SSE transaction streams',
      registers: [registry],
    });
  }
  if (!_streamReconnectsTotal) {
    _streamReconnectsTotal = new client.Counter({
      name: 'horizon_stream_reconnects_total',
      help: 'Total number of Horizon stream reconnect attempts',
      labelNames: ['school_id'],
      registers: [registry],
    });
  }
  if (!_streamLag) {
    _streamLag = new client.Gauge({
      name: 'horizon_stream_lag_seconds',
      help: 'Seconds since the last transaction was received on any stream',
      registers: [registry],
    });
  }
}

function _incReconnects(schoolId) {
  try {
    _ensureMetrics();
    if (_streamReconnectsTotal) _streamReconnectsTotal.inc({ school_id: schoolId });
  } catch (_) { /* metrics optional */ }
}

function _setOpenCount(n) {
  try {
    _ensureMetrics();
    if (_streamsOpen) _streamsOpen.set(n);
  } catch (_) { /* metrics optional */ }
}

function _setLag(seconds) {
  try {
    _ensureMetrics();
    if (_streamLag) _streamLag.set(seconds);
  } catch (_) { /* metrics optional */ }
}

// ── SchoolStream — manages one school's Horizon SSE stream ────────────────────

class SchoolStream {
  /**
   * @param {object} school  Mongoose school document (lean or live)
   */
  constructor(school) {
    this.schoolId = school.schoolId;
    this.stellarAddress = school.stellarAddress;
    this.syncCursor = school.syncCursor || null;

    this._closeStream = null;   // function returned by .stream() to stop it
    this._reconnectTimer = null;
    this._reconnectDelayMs = RECONNECT_INITIAL_MS;
    this._active = false;
    this._lastMessageAt = null;
    this._fencingToken = Date.now(); // monotonically increasing lock token per stream
  }

  start() {
    if (this._active) return;
    this._active = true;
    logger.info('Starting Horizon stream', { schoolId: this.schoolId });
    this._connect();
  }

  stop() {
    this._active = false;
    this._clearReconnectTimer();
    this._closeStream?.();
    this._closeStream = null;
    logger.info('Stopped Horizon stream', { schoolId: this.schoolId });
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _connect() {
    if (!this._active) return;

    try {
      let builder = defaultServer
        .transactions()
        .forAccount(this.stellarAddress)
        .order('asc');

      if (this.syncCursor) {
        builder = builder.cursor(this.syncCursor);
      }

      this._closeStream = builder.stream({
        onmessage: (tx) => this._onMessage(tx),
        onerror: (err) => this._onError(err),
      });

      // Reset backoff on successful connect
      this._reconnectDelayMs = RECONNECT_INITIAL_MS;
      logger.debug('Horizon stream opened', {
        schoolId: this.schoolId,
        cursor: this.syncCursor || 'genesis',
      });
    } catch (err) {
      logger.error('Failed to open Horizon stream', {
        schoolId: this.schoolId,
        error: err.message,
      });
      this._scheduleReconnect();
    }
  }

  async _onMessage(tx) {
    if (!this._active) return;

    this._lastMessageAt = Date.now();
    _setLag(0);

    const schoolForProcess = {
      schoolId: this.schoolId,
      stellarAddress: this.stellarAddress,
      feeAmount: undefined, // processTransaction reads from Student
      suspiciousPaymentMultiplier: undefined,
      suspiciousAmountConfig: undefined,
    };

    // Re-fetch the school so we always have fresh config (multiplier, etc.)
    try {
      const freshSchool = await School.findOne({ schoolId: this.schoolId, isActive: true }).lean();
      if (!freshSchool) {
        // School was deactivated mid-stream — stop.
        logger.info('School deactivated; stopping stream', { schoolId: this.schoolId });
        this.stop();
        return;
      }
      Object.assign(schoolForProcess, freshSchool);
    } catch (err) {
      logger.warn('Could not refresh school config; using stale data', {
        schoolId: this.schoolId,
        error: err.message,
      });
    }

    try {
      const result = await processTransaction(tx, schoolForProcess, this._fencingToken);

      if (result.processed) {
        logger.info('Stream: payment detected and recorded', {
          schoolId: this.schoolId,
          txHash: tx.hash,
        });
      }

      // Advance and persist cursor after every message (processed or skipped).
      if (tx.paging_token && tx.paging_token !== this.syncCursor) {
        this.syncCursor = tx.paging_token;
        await School.updateOne(
          { schoolId: this.schoolId },
          { $set: { syncCursor: this.syncCursor } }
        ).catch((err) =>
          logger.warn('Failed to persist stream cursor', {
            schoolId: this.schoolId,
            error: err.message,
          })
        );
      }
    } catch (err) {
      // A processing error must not kill the stream — log and continue.
      logger.error('Stream: error processing transaction', {
        schoolId: this.schoolId,
        txHash: tx.hash,
        error: err.message,
      });
    }
  }

  _onError(err) {
    if (!this._active) return;
    const message = err?.message || String(err);
    logger.warn('Horizon stream error — will reconnect', {
      schoolId: this.schoolId,
      error: message,
    });
    this._closeStream?.();
    this._closeStream = null;
    _incReconnects(this.schoolId);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this._active) return;
    this._clearReconnectTimer();
    logger.debug('Scheduling stream reconnect', {
      schoolId: this.schoolId,
      delayMs: this._reconnectDelayMs,
    });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelayMs);

    // Exponential backoff with cap
    this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /** Seconds since the last message, or null if no message yet. */
  get lagSeconds() {
    if (!this._lastMessageAt) return null;
    return (Date.now() - this._lastMessageAt) / 1000;
  }
}

// ── StreamingService — manages all school streams ─────────────────────────────

/** Map<schoolId, SchoolStream> */
const _streams = new Map();

let _schoolsRefreshTimer = null;
let _safetyNetTimer = null;
let _lagMonitorTimer = null;
let _running = false;

/**
 * Reconcile the set of open streams against the current list of active schools.
 * Opens streams for new schools, closes streams for deactivated schools.
 */
async function _reconcileStreams() {
  try {
    const schools = await School.find({ isActive: true }).lean();
    const activeIds = new Set(schools.map(s => s.schoolId));

    // Close streams for schools no longer active
    for (const [schoolId, stream] of _streams) {
      if (!activeIds.has(schoolId)) {
        stream.stop();
        _streams.delete(schoolId);
        logger.info('Removed stream for deactivated school', { schoolId });
      }
    }

    // Open streams for new active schools
    for (const school of schools) {
      if (!_streams.has(school.schoolId)) {
        const stream = new SchoolStream(school);
        _streams.set(school.schoolId, stream);
        stream.start();
      }
    }

    _setOpenCount(_streams.size);
    logger.debug('Stream reconciliation complete', { openStreams: _streams.size });
  } catch (err) {
    logger.error('Error reconciling Horizon streams', { error: err.message });
  }
}

/**
 * Update the lag metric periodically — the lag gauge is the max lag across all open streams.
 */
function _updateLagMetric() {
  let maxLag = 0;
  for (const stream of _streams.values()) {
    const lag = stream.lagSeconds;
    if (lag !== null && lag > maxLag) maxLag = lag;
  }
  _setLag(maxLag);
}

/**
 * Start the streaming service.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
async function startStreaming() {
  if (!STREAMING_ENABLED) {
    logger.info('Horizon streaming disabled (HORIZON_STREAMING_ENABLED=false); using polling only');
    return;
  }

  if (_running) {
    logger.warn('Horizon streaming service already running');
    return;
  }

  _running = true;
  logger.info('Starting Horizon streaming service', {
    safetyNetIntervalMs: SAFETY_NET_INTERVAL_MS,
    schoolsRefreshMs: SCHOOLS_REFRESH_MS,
  });

  // Initial stream setup
  await _reconcileStreams();

  // Periodic reconciliation: pick up newly registered schools
  _schoolsRefreshTimer = setInterval(_reconcileStreams, SCHOOLS_REFRESH_MS);
  _schoolsRefreshTimer.unref?.();

  // Lag monitor (every 30 s)
  _lagMonitorTimer = setInterval(_updateLagMetric, 30_000);
  _lagMonitorTimer.unref?.();

  // Safety-net: downgrade to a low-frequency full poll so any gaps during
  // reconnect windows are eventually filled. We override the polling interval
  // by setting SYNC_INTERVAL_MS to the safety-net value rather than 0, so the
  // existing transactionPollingService continues to work as the fallback.
  if (SAFETY_NET_INTERVAL_MS > 0) {
    const { startPolling, stopPolling } = require('./transactionPollingService');
    // Override the polling interval to safety-net cadence.
    const origInterval = process.env.SYNC_INTERVAL_MS;
    process.env.SYNC_INTERVAL_MS = String(SAFETY_NET_INTERVAL_MS);

    _safetyNetTimer = setInterval(async () => {
      logger.debug('Running safety-net poll to fill stream gaps');
      try {
        const { pollAllSchools } = require('./transactionPollingService');
        await pollAllSchools();
      } catch (err) {
        logger.error('Safety-net poll error', { error: err.message });
      }
    }, SAFETY_NET_INTERVAL_MS);
    _safetyNetTimer.unref?.();

    // Restore env for any other callers
    if (origInterval !== undefined) process.env.SYNC_INTERVAL_MS = origInterval;
    else delete process.env.SYNC_INTERVAL_MS;
  }

  try {
    const { markStarted, WORKER_NAMES } = require('./workerHeartbeat');
    if (WORKER_NAMES.HORIZON_STREAMING) markStarted(WORKER_NAMES.HORIZON_STREAMING);
  } catch (_) { /* non-critical */ }
}

/**
 * Stop all streams and clear timers.
 */
function stopStreaming() {
  if (!_running) return;
  _running = false;

  if (_schoolsRefreshTimer) { clearInterval(_schoolsRefreshTimer); _schoolsRefreshTimer = null; }
  if (_safetyNetTimer)      { clearInterval(_safetyNetTimer);      _safetyNetTimer = null; }
  if (_lagMonitorTimer)     { clearInterval(_lagMonitorTimer);     _lagMonitorTimer = null; }

  for (const stream of _streams.values()) stream.stop();
  _streams.clear();
  _setOpenCount(0);

  try {
    const { markStopped, WORKER_NAMES } = require('./workerHeartbeat');
    if (WORKER_NAMES.HORIZON_STREAMING) markStopped(WORKER_NAMES.HORIZON_STREAMING);
  } catch (_) { /* non-critical */ }

  logger.info('Horizon streaming service stopped');
}

/**
 * Return a snapshot of all open streams for health/admin endpoints.
 */
function getStreamStatus() {
  const streams = [];
  for (const [schoolId, stream] of _streams) {
    streams.push({
      schoolId,
      active: stream._active,
      cursor: stream.syncCursor,
      lagSeconds: stream.lagSeconds,
      reconnectDelayMs: stream._reconnectDelayMs,
    });
  }
  return { enabled: STREAMING_ENABLED, running: _running, openStreams: _streams.size, streams };
}

module.exports = {
  startStreaming,
  stopStreaming,
  getStreamStatus,
  // Exposed for testing
  _reconcileStreams,
  _streams,
  SchoolStream,
};
