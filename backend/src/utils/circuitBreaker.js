'use strict';

/**
 * Generic circuit breaker implementation for handling provider degradation.
 *
 * States:
 *   - CLOSED: normal operation, requests pass through
 *   - OPEN: circuit is broken, requests fail immediately after failure threshold
 *   - HALF_OPEN: testing if service recovered after timeout
 *
 * Transitions:
 *   CLOSED -> OPEN: after failureThreshold consecutive failures
 *   OPEN -> HALF_OPEN: after resetTimeoutMs has elapsed
 *   HALF_OPEN -> CLOSED: after successThreshold consecutive successes
 *   HALF_OPEN -> OPEN: after any failure in half-open state
 */

const CB_STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

function _cbStateNum(state) {
  if (state === CB_STATE.CLOSED) return 0;
  if (state === CB_STATE.OPEN) return 1;
  return 2;
}

class CircuitBreaker {
  /**
   * @param {string} name - Identifier for this CB instance (e.g., 'coingecko_price_feed')
   * @param {object} opts
   * @param {number} [opts.failureThreshold=5] - Consecutive failures before opening
   * @param {number} [opts.resetTimeoutMs=30000] - Time CB stays open before half-open
   * @param {number} [opts.successThreshold=2] - Successes in half-open to close
   * @param {function} [opts.onStateChange] - Callback when state changes: (oldState, newState)
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold || 5;
    this.resetTimeoutMs = opts.resetTimeoutMs || 30_000;
    this.successThreshold = opts.successThreshold || 2;
    this.onStateChange = opts.onStateChange || null;

    this.state = CB_STATE.CLOSED;
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = null;
  }

  /**
   * Check if requests can be made (CLOSED or HALF_OPEN).
   * Auto-transitions OPEN -> HALF_OPEN if timeout elapsed.
   * @returns {boolean}
   */
  isAvailable() {
    if (this.state === CB_STATE.CLOSED || this.state === CB_STATE.HALF_OPEN) {
      return true;
    }
    if (this.state === CB_STATE.OPEN) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this._transition(CB_STATE.HALF_OPEN);
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Record a successful request. Resets failure counter; closes CB from HALF_OPEN.
   */
  recordSuccess() {
    if (this.state === CB_STATE.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.failures = 0;
        this.halfOpenSuccesses = 0;
        this._transition(CB_STATE.CLOSED);
      }
    } else if (this.state === CB_STATE.CLOSED) {
      this.failures = 0;
    }
  }

  /**
   * Record a failure. Opens CB if threshold reached, or immediately in HALF_OPEN.
   */
  recordFailure() {
    this.failures++;
    this.halfOpenSuccesses = 0;
    if (this.state === CB_STATE.HALF_OPEN || this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this._transition(CB_STATE.OPEN);
    }
  }

  /**
   * Get the current state string.
   */
  getState() {
    return this.state;
  }

  /**
   * Get the current state as a numeric value (for metrics).
   */
  getStateNum() {
    return _cbStateNum(this.state);
  }

  /**
   * Get failure count.
   */
  getFailures() {
    return this.failures;
  }

  /**
   * Get time until CB can transition from OPEN to HALF_OPEN (ms).
   * Returns 0 if already available.
   */
  getTimeUntilRetry() {
    if (this.state !== CB_STATE.OPEN) return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.resetTimeoutMs - elapsed);
  }

  /**
   * Transition to a new state and invoke callback if registered.
   * @private
   */
  _transition(newState) {
    if (newState === this.state) return;
    const oldState = this.state;
    this.state = newState;
    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch (_) {
        // Swallow callback errors
      }
    }
  }

  /**
   * Reset the circuit breaker to CLOSED state (for testing).
   */
  reset() {
    this.state = CB_STATE.CLOSED;
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = null;
  }
}

module.exports = {
  CircuitBreaker,
  CB_STATE,
};
