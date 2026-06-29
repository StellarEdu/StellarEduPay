'use strict';

/**
 * HorizonFailoverClient
 *
 * Wraps the Stellar Horizon.Server SDK with:
 *   - A prioritized list of Horizon URLs (STELLAR_HORIZON_URLS env var, or
 *     fall back to the single STELLAR_HORIZON_URL / HORIZON_URL).
 *   - Health-aware failover: on each call failure the client tries the next
 *     URL in the list before giving up.
 *   - A per-endpoint circuit breaker: after CB_FAILURE_THRESHOLD consecutive
 *     5xx/429 responses (or network errors) the circuit opens and that
 *     endpoint is skipped for CB_RESET_TIMEOUT_MS.  It then enters HALF-OPEN,
 *     allowing one probe request.  Two consecutive probe successes close it.
 *   - All existing exponential-backoff behaviour in withStellarRetry is
 *     preserved: this layer sits above it and provides endpoint selection.
 *   - Prometheus counters/gauges for: failover events, circuit state changes,
 *     and the currently active endpoint index.
 *
 * Environment variables:
 *   STELLAR_HORIZON_URLS          Comma-separated, priority-ordered list of
 *                                 Horizon base URLs.  Falls back to
 *                                 STELLAR_HORIZON_URL / HORIZON_URL.
 *   CB_FAILURE_THRESHOLD          Consecutive failures before CB opens   (5)
 *   CB_RESET_TIMEOUT_MS           Time CB stays open before half-open  (30000)
 *   CB_HALF_OPEN_SUCCESS_THRESHOLD Probe successes needed to close CB    (2)
 *
 * @module horizonFailoverClient
 */

const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config');
const logger = require('../utils/logger');
// metrics is required lazily inside _ensureMetrics() to avoid a circular
// dependency: horizonFailoverClient → metrics → stellarConfig → horizonFailoverClient

// ── Circuit-breaker states ────────────────────────────────────────────────────
const CB_STATE = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' });

// ── Configuration ─────────────────────────────────────────────────────────────
const CB_FAILURE_THRESHOLD = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
const CB_RESET_TIMEOUT_MS = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30_000;
const CB_HALF_OPEN_SUCCESS_THRESHOLD =
  parseInt(process.env.CB_HALF_OPEN_SUCCESS_THRESHOLD, 10) || 2;

// ── Prometheus metrics (lazily registered so they survive jest module resets) ─
let _horizonFailovers;
let _horizonCbTransitions;
let _horizonActiveEndpoint;
let _horizonCbState;
let _horizonCbFailures;

function _ensureMetrics() {
  let metrics;
  try {
    metrics = require('../metrics');
  } catch (_) {
    return; // metrics not available (tests or early boot)
  }
  if (!metrics) return;
  const { registry } = metrics;
  const client = require('prom-client');

  if (!_horizonFailovers) {
    _horizonFailovers = new client.Counter({
      name: 'horizon_failover_total',
      help: 'Total number of Horizon endpoint failover events',
      labelNames: ['from_url', 'to_url'],
      registers: [registry],
    });
  }
  if (!_horizonCbTransitions) {
    _horizonCbTransitions = new client.Counter({
      name: 'horizon_circuit_breaker_transitions_total',
      help: 'Number of circuit-breaker state transitions per Horizon endpoint',
      labelNames: ['url', 'from_state', 'to_state'],
      registers: [registry],
    });
  }
  if (!_horizonActiveEndpoint) {
    _horizonActiveEndpoint = new client.Gauge({
      name: 'horizon_active_endpoint_index',
      help: 'Index (0-based) of the currently active Horizon endpoint in the priority list',
      registers: [registry],
    });
  }
  if (!_horizonCbState) {
    _horizonCbState = new client.Gauge({
      name: 'horizon_circuit_breaker_state',
      help: 'Circuit-breaker state per Horizon endpoint: 0=closed 1=open 2=half_open',
      labelNames: ['url'],
      registers: [registry],
    });
  }
  if (!_horizonCbFailures) {
    _horizonCbFailures = new client.Gauge({
      name: 'horizon_circuit_breaker_failures',
      help: 'Consecutive failures tracked per Horizon endpoint circuit breaker',
      labelNames: ['url'],
      registers: [registry],
    });
  }
}

function _cbStateNum(state) {
  if (state === CB_STATE.CLOSED) return 0;
  if (state === CB_STATE.OPEN) return 1;
  return 2;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the comma-separated STELLAR_HORIZON_URLS env var.
 * Falls back to the single-URL config value so existing deployments continue
 * working without any env change.
 * @returns {string[]} Non-empty, deduplicated list of Horizon base URLs.
 */
function resolveHorizonUrls() {
  const raw = process.env.STELLAR_HORIZON_URLS;
  if (raw && raw.trim()) {
    const urls = raw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }
  // Single-URL fallback
  return [
    process.env.STELLAR_HORIZON_URL ||
      process.env.HORIZON_URL ||
      config.HORIZON_URL ||
      'https://horizon.stellar.org',
  ];
}

function isTransientFailure(err) {
  const status =
    err.response?.status ||
    err.response?.statusCode ||
    err.status ||
    err.statusCode;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const NETWORK_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
  if (NETWORK_CODES.includes(err.code)) return true;
  if (/timeout|network|socket hang up/i.test(err.message || '')) return true;
  return false;
}

// ── CircuitBreaker ────────────────────────────────────────────────────────────

class CircuitBreaker {
  constructor(url) {
    this.url = url;
    this.state = CB_STATE.CLOSED;
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = null;
  }

  isAvailable() {
    if (this.state === CB_STATE.CLOSED || this.state === CB_STATE.HALF_OPEN) return true;
    if (this.state === CB_STATE.OPEN) {
      if (Date.now() - this.openedAt >= CB_RESET_TIMEOUT_MS) {
        this._transition(CB_STATE.HALF_OPEN);
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess() {
    if (this.state === CB_STATE.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= CB_HALF_OPEN_SUCCESS_THRESHOLD) {
        this.failures = 0;
        this.halfOpenSuccesses = 0;
        this._transition(CB_STATE.CLOSED);
      }
    } else {
      this.failures = 0;
    }
    this._updateFailuresMetric();
  }

  recordFailure() {
    this.failures++;
    this.halfOpenSuccesses = 0;
    if (this.state === CB_STATE.HALF_OPEN || this.failures >= CB_FAILURE_THRESHOLD) {
      this.openedAt = Date.now();
      this._transition(CB_STATE.OPEN);
    }
    this._updateFailuresMetric();
  }

  _updateFailuresMetric() {
    try {
      _ensureMetrics();
      if (_horizonCbFailures) _horizonCbFailures.set({ url: this.url }, this.failures);
    } catch (_) { /* metrics optional */ }
  }

  _transition(newState) {
    if (newState === this.state) return;
    const prev = this.state;
    this.state = newState;
    logger.info(
      `[HorizonFailoverClient] CB ${prev} → ${newState} for ${this.url}` +
        (newState === CB_STATE.OPEN ? ` (resets in ${CB_RESET_TIMEOUT_MS}ms)` : ''),
    );
    try {
      _ensureMetrics();
      if (_horizonCbTransitions) _horizonCbTransitions.inc({ url: this.url, from_state: prev, to_state: newState });
      if (_horizonCbState) _horizonCbState.set({ url: this.url }, _cbStateNum(newState));
    } catch (_) { /* metrics optional */ }
  }

  getState() { return this.state; }
}

// ── HorizonFailoverClient ─────────────────────────────────────────────────────

class HorizonFailoverClient {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.urls]          Override URL list (useful in tests)
   * @param {number}   [opts.timeoutMs]     Per-request timeout passed to Horizon.Server
   */
  constructor(opts = {}) {
    this._urls = opts.urls || resolveHorizonUrls();
    if (this._urls.length === 0) throw new Error('[HorizonFailoverClient] No Horizon URLs configured');

    this._timeoutMs = opts.timeoutMs || config.STELLAR_TIMEOUT_MS || 10_000;
    this._activeIndex = 0;

    // One Horizon.Server + CircuitBreaker per URL
    this._servers = this._urls.map((url) => ({
      url,
      server: new StellarSdk.Horizon.Server(url, { timeout: this._timeoutMs }),
      cb: new CircuitBreaker(url),
      failoverCount: 0,
    }));

    // Expose the active server as `.server` for drop-in compatibility with
    // the existing code that uses `require('../config/stellarConfig').server`
    this._refreshActiveServer();

    logger.info('[HorizonFailoverClient] Initialized', {
      urls: this._urls,
      cbFailureThreshold: CB_FAILURE_THRESHOLD,
      cbResetTimeoutMs: CB_RESET_TIMEOUT_MS,
    });

    try {
      _ensureMetrics();
      if (_horizonActiveEndpoint) _horizonActiveEndpoint.set(this._activeIndex);
      this._servers.forEach(({ url, cb }) => {
        if (_horizonCbState) _horizonCbState.set({ url }, _cbStateNum(cb.getState()));
      });
    } catch (_) { /* metrics optional */ }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _refreshActiveServer() {
    this.server = this._servers[this._activeIndex].server;
  }

  _nextAvailableIndex(skipIndex) {
    for (let i = 0; i < this._servers.length; i++) {
      const idx = (skipIndex + 1 + i) % this._servers.length;
      if (this._servers[idx].cb.isAvailable()) return idx;
    }
    return null; // all CBs open
  }

  _failover(fromIndex) {
    const nextIdx = this._nextAvailableIndex(fromIndex);
    if (nextIdx === null) return false;

    const fromUrl = this._urls[fromIndex];
    const toUrl = this._urls[nextIdx];
    logger.warn(`[HorizonFailoverClient] Failing over ${fromUrl} → ${toUrl}`);

    this._servers[fromIndex].failoverCount++;
    this._activeIndex = nextIdx;
    this._refreshActiveServer();

    try {
      _ensureMetrics();
      if (_horizonFailovers) _horizonFailovers.inc({ from_url: fromUrl, to_url: toUrl });
      if (_horizonActiveEndpoint) _horizonActiveEndpoint.set(nextIdx);
    } catch (_) { /* metrics optional */ }

    return true;
  }

  // ── Public call wrapper ────────────────────────────────────────────────────

  /**
   * Execute `fn(server)` against the active Horizon endpoint, failing over to
   * the next available endpoint if the call fails with a transient error.
   *
   * The caller is still responsible for the top-level retry loop
   * (withStellarRetry).  This method handles *endpoint selection* only —
   * it tries each available endpoint once before re-throwing.
   *
   * @param {function(StellarSdk.Horizon.Server): Promise<*>} fn
   * @returns {Promise<*>}
   */
  async call(fn) {
    const tried = new Set();
    let currentIdx = this._activeIndex;

    // If the initially selected endpoint's CB is already open, find the first
    // available one before we even make the first attempt.
    if (!this._servers[currentIdx].cb.isAvailable()) {
      const next = this._nextAvailableIndex(currentIdx - 1);
      if (next === null) {
        throw Object.assign(
          new Error('All Horizon endpoints are unavailable (circuit breakers open)'),
          { code: 'HORIZON_ALL_UNAVAILABLE', status: 503 },
        );
      }
      this._activeIndex = next;
      this._refreshActiveServer();
      currentIdx = next;
    }

    while (tried.size < this._servers.length) {
      if (tried.has(currentIdx)) break;
      tried.add(currentIdx);

      const { server, cb, url } = this._servers[currentIdx];
      try {
        const result = await fn(server);
        cb.recordSuccess();
        // If we succeeded on a non-primary endpoint, keep it as active.
        if (this._activeIndex !== currentIdx) {
          this._activeIndex = currentIdx;
          this._refreshActiveServer();
          try { _ensureMetrics(); if (_horizonActiveEndpoint) _horizonActiveEndpoint.set(currentIdx); } catch (_) {}
        }
        return result;
      } catch (err) {
        if (isTransientFailure(err)) {
          cb.recordFailure();
          logger.warn(`[HorizonFailoverClient] Transient failure on ${url}:`, err.message);

          const nextIdx = this._nextAvailableIndex(currentIdx);
          if (nextIdx === null || nextIdx === currentIdx) {
            throw err; // no more options
          }
          const fromUrl = this._urls[currentIdx];
          const toUrl = this._urls[nextIdx];
          logger.warn(`[HorizonFailoverClient] Failing over ${fromUrl} → ${toUrl}`);
          try {
            _ensureMetrics();
            if (_horizonFailovers) _horizonFailovers.inc({ from_url: fromUrl, to_url: toUrl });
            if (_horizonActiveEndpoint) _horizonActiveEndpoint.set(nextIdx);
          } catch (_) {}
          this._activeIndex = nextIdx;
          this._refreshActiveServer();
          currentIdx = nextIdx;
        } else {
          // Non-transient (4xx, not 429) — don't failover, surface immediately
          throw err;
        }
      }
    }

    throw Object.assign(
      new Error('All Horizon endpoints failed'),
      { code: 'HORIZON_ALL_FAILED', status: 503 },
    );
  }

  // ── Health / introspection ─────────────────────────────────────────────────

  /** Return the URL currently used for requests. */
  get activeUrl() { return this._urls[this._activeIndex]; }

  /** Return a snapshot of every endpoint's circuit-breaker status. */
  getCircuitBreakerStatus() {
    return this._servers.map(({ url, cb, failoverCount }, idx) => ({
      url,
      index: idx,
      active: idx === this._activeIndex,
      failoverCount,
      circuitBreaker: {
        state: cb.getState(),
        failures: cb.failures,
        openedAt: cb.openedAt,
        resetsAt:
          cb.getState() === CB_STATE.OPEN
            ? new Date(cb.openedAt + CB_RESET_TIMEOUT_MS).toISOString()
            : null,
      },
      thresholds: {
        failureThreshold: CB_FAILURE_THRESHOLD,
        resetTimeoutMs: CB_RESET_TIMEOUT_MS,
        halfOpenSuccessThreshold: CB_HALF_OPEN_SUCCESS_THRESHOLD,
      },
    }));
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance = null;

function getInstance(opts) {
  if (!_instance) _instance = new HorizonFailoverClient(opts);
  return _instance;
}

function resetInstance() {
  _instance = null;
}

module.exports = {
  HorizonFailoverClient,
  CircuitBreaker,
  CB_STATE,
  CB_FAILURE_THRESHOLD,
  CB_RESET_TIMEOUT_MS,
  CB_HALF_OPEN_SUCCESS_THRESHOLD,
  getInstance,
  resetInstance,
  resolveHorizonUrls,
  isTransientFailure,
};
