'use strict';

/**
 * Coordinated cross-school Horizon request budget (#1124).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCALING CEILING THIS EXISTS TO REMOVE
 * ─────────────────────────────────────────────────────────────────────────────
 * The poller used to treat every school's sync as an independent operation:
 * `Promise.allSettled(schools.map(pollSchoolTransactions))` fanned out to all
 * active schools at once, each free to drain up to MAX_PAGES_PER_POLL pages.
 * Horizon request volume therefore scaled as
 *
 *     requests/cycle  ≈  Σ over schools (pages needed by that school)
 *
 * growing linearly with the number of onboarded schools, while Horizon's rate
 * limit for our IP/key is a *fixed* budget that does not grow at all. That makes
 * rate-limiting a predictable scaling ceiling rather than a rare edge case.
 *
 * The per-call retry in withStellarRetry does not address this. It caps at a
 * short backoff and, worse, is applied independently per call — so under
 * sustained 429s every school retries simultaneously, converting one rate-limit
 * event into a thundering herd that keeps the limit saturated.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES INSTEAD
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. BUDGET. A token bucket sized from Horizon's actual rate limit and the poll
 *    interval bounds total requests per cycle across ALL schools. Work that
 *    doesn't fit is deferred to the next cycle instead of being issued and
 *    429'd. Deferral is cheap and ordered; a 429 storm is neither.
 *
 * 2. PRIORITY. The budget is spent on the schools where delay actually matters.
 *    A school with unconfirmed payments awaiting verification is polled ahead of
 *    a fully-settled school whose poll would return nothing. Under constraint
 *    this is what keeps *perceived* sync delay low even when raw throughput is
 *    capped — the parent waiting on a payment is in the first group.
 *
 * 3. AGING. Priority alone starves quiet schools forever, so every deferred
 *    cycle raises a school's score. This bounds worst-case staleness for even
 *    the lowest-priority tenant — the guarantee the SLA in
 *    docs/horizon-rate-limits.md is stated against.
 *
 * 4. ADAPTATION. Observed 429s shrink the budget multiplicatively; clean cycles
 *    grow it back additively (AIMD, the same control law TCP uses). The system
 *    converges on the real limit instead of assuming the configured one is
 *    right, which matters because Horizon's limit varies by provider and plan.
 *
 * Distributed note: the budget is per-process. With N replicas polling, set
 * HORIZON_POLL_REPLICA_COUNT=N so each takes 1/N of the global budget. The
 * per-school distributed lock already prevents two replicas syncing the same
 * school, so this partitioning is safe, if conservative.
 */

const logger = require('../utils/logger').child('HorizonPollBudget');

// Horizon's default anonymous limit is 3600 requests/hour. Operators on a paid
// or self-hosted instance should raise this to match their actual allowance.
const HORIZON_RATE_LIMIT_PER_HOUR = parseInt(
  process.env.HORIZON_RATE_LIMIT_PER_HOUR || '3600', 10);

// Fraction of the limit the poller may consume. Held below 1.0 deliberately:
// polling is not the only Horizon consumer — the verify endpoint, retry worker
// and confirmation finalizer all share the same allowance, and they are
// user-facing so they must never be starved by background polling.
const POLL_BUDGET_SAFETY_FACTOR = parseFloat(
  process.env.HORIZON_POLL_BUDGET_SAFETY_FACTOR || '0.6');

// Number of replicas sharing the Horizon allowance.
const REPLICA_COUNT = Math.max(1, parseInt(
  process.env.HORIZON_POLL_REPLICA_COUNT || '1', 10));

// Floor so a misconfiguration can never wedge polling entirely.
const MIN_BUDGET_PER_CYCLE = Math.max(1, parseInt(
  process.env.HORIZON_POLL_MIN_BUDGET || '4', 10));

// AIMD constants. Multiplicative decrease reacts fast to a real limit; additive
// increase probes back slowly so we don't oscillate into the limit repeatedly.
const AIMD_DECREASE_FACTOR = 0.5;
const AIMD_INCREASE_TOKENS = 2;

// Priority weights. Pending verifications dominate: that is the case where a
// parent is actively waiting for a payment to appear.
const PRIORITY_PENDING_PAYMENT = 100;
const PRIORITY_RECENT_ACTIVITY = 20;
const PRIORITY_NEVER_SYNCED = 250;   // backfill a new school promptly
const PRIORITY_AGING_PER_CYCLE = 15; // starvation guard

// A school with recent on-chain activity is more likely to have more.
const RECENT_ACTIVITY_WINDOW_MS = parseInt(
  process.env.HORIZON_POLL_RECENT_ACTIVITY_WINDOW_MS || String(60 * 60 * 1000), 10);

/**
 * Compute the nominal number of Horizon requests the poller may issue in one
 * cycle of `intervalMs`, given the configured hourly limit.
 *
 * @param {number} intervalMs - Poll cycle interval
 * @returns {number} requests permitted per cycle (>= MIN_BUDGET_PER_CYCLE)
 */
function computeCycleBudget(intervalMs) {
  const perMs = HORIZON_RATE_LIMIT_PER_HOUR / 3600000;
  const raw = perMs * intervalMs * POLL_BUDGET_SAFETY_FACTOR / REPLICA_COUNT;
  return Math.max(MIN_BUDGET_PER_CYCLE, Math.floor(raw));
}

/**
 * Score a school for this cycle. Higher is polled sooner.
 *
 * @param {object} school - School document (needs schoolId, syncCursor)
 * @param {object} signals
 * @param {number} [signals.pendingCount] - Unconfirmed payments awaiting verification
 * @param {number|Date} [signals.lastActivityAt] - Most recent confirmed payment
 * @param {number} [signals.cyclesDeferred] - Consecutive cycles skipped for budget
 * @param {number} [signals.now] - Injectable clock for deterministic tests
 * @returns {number} priority score
 */
function computeSchoolPriority(school, signals = {}) {
  const {
    pendingCount = 0,
    lastActivityAt = null,
    cyclesDeferred = 0,
    now = Date.now(),
  } = signals;

  let score = 0;

  // A school that has never been synced has no cursor — it needs its initial
  // backfill before it can report anything at all to its users.
  if (!school.syncCursor) score += PRIORITY_NEVER_SYNCED;

  // The headline signal: someone is waiting on these.
  score += Math.min(pendingCount, 10) * PRIORITY_PENDING_PAYMENT;

  if (lastActivityAt) {
    const age = now - new Date(lastActivityAt).getTime();
    if (age >= 0 && age < RECENT_ACTIVITY_WINDOW_MS) {
      // Decay linearly across the window rather than a cliff edge, so a school
      // doesn't lurch between priority tiers on either side of a threshold.
      const freshness = 1 - age / RECENT_ACTIVITY_WINDOW_MS;
      score += PRIORITY_RECENT_ACTIVITY * freshness;
    }
  }

  // Aging — the starvation guard that makes worst-case staleness bounded.
  score += cyclesDeferred * PRIORITY_AGING_PER_CYCLE;

  return score;
}

/**
 * Order schools most-urgent-first for this cycle.
 *
 * @param {Array<object>} schools
 * @param {Map<string, object>} signalsBySchoolId
 * @param {number} [now]
 * @returns {Array<{school: object, priority: number}>}
 */
function orderSchoolsByPriority(schools, signalsBySchoolId = new Map(), now = Date.now()) {
  return schools
    .map(school => ({
      school,
      priority: computeSchoolPriority(school, {
        ...(signalsBySchoolId.get(school.schoolId) || {}),
        now,
      }),
    }))
    // Tie-break on schoolId so ordering is deterministic and testable rather
    // than dependent on Mongo's return order.
    .sort((a, b) => (b.priority - a.priority) ||
      String(a.school.schoolId).localeCompare(String(b.school.schoolId)));
}

/**
 * The shared per-cycle request budget.
 *
 * Deliberately simple and synchronous: it is consulted on the hot path before
 * every Horizon page fetch, so it must not itself do I/O.
 */
class HorizonPollBudget {
  /**
   * @param {object} [opts]
   * @param {number} [opts.intervalMs] - Poll interval used to size the budget
   * @param {number} [opts.budgetOverride] - Explicit budget, bypassing the
   *   rate-limit computation (used by tests and load simulations)
   */
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs || 30000;
    this.nominalBudget = opts.budgetOverride || computeCycleBudget(this.intervalMs);

    // The AIMD-adjusted ceiling. Starts at nominal and moves with observed 429s.
    this.currentCeiling = this.nominalBudget;

    this.remaining = this.currentCeiling;
    this.consumedThisCycle = 0;
    this.deniedThisCycle = 0;
    this.rateLimitEventsThisCycle = 0;

    // Per-school deferral counters, the input to priority aging.
    this.cyclesDeferred = new Map();

    this.cycles = 0;
  }

  /**
   * Begin a cycle: apply AIMD from what the last cycle observed, then refill.
   * @returns {number} tokens available this cycle
   */
  startCycle() {
    if (this.cycles > 0) {
      if (this.rateLimitEventsThisCycle > 0) {
        // We hit the real limit — back off hard and fast.
        const next = Math.max(
          MIN_BUDGET_PER_CYCLE,
          Math.floor(this.currentCeiling * AIMD_DECREASE_FACTOR),
        );
        if (next !== this.currentCeiling) {
          logger.warn('Horizon rate limit observed — reducing poll budget', {
            from: this.currentCeiling,
            to: next,
            rateLimitEvents: this.rateLimitEventsThisCycle,
          });
        }
        this.currentCeiling = next;
      } else if (this.currentCeiling < this.nominalBudget) {
        // Clean cycle — probe back toward nominal, gently.
        this.currentCeiling = Math.min(
          this.nominalBudget,
          this.currentCeiling + AIMD_INCREASE_TOKENS,
        );
      }
    }

    this.remaining = this.currentCeiling;
    this.consumedThisCycle = 0;
    this.deniedThisCycle = 0;
    this.rateLimitEventsThisCycle = 0;
    this.cycles++;

    return this.remaining;
  }

  /**
   * Try to reserve `n` Horizon requests.
   * @returns {boolean} true if granted
   */
  tryConsume(n = 1) {
    if (this.remaining < n) {
      this.deniedThisCycle += n;
      return false;
    }
    this.remaining -= n;
    this.consumedThisCycle += n;
    return true;
  }

  /** Return unused tokens (e.g. a school drained early and needed fewer pages). */
  refund(n = 1) {
    this.remaining = Math.min(this.currentCeiling, this.remaining + n);
    this.consumedThisCycle = Math.max(0, this.consumedThisCycle - n);
  }

  /** Record an observed Horizon 429, which drives the multiplicative decrease. */
  recordRateLimited() {
    this.rateLimitEventsThisCycle++;
  }

  /** Note that a school was skipped this cycle for lack of budget. */
  recordDeferred(schoolId) {
    this.cyclesDeferred.set(schoolId, (this.cyclesDeferred.get(schoolId) || 0) + 1);
  }

  /** Note that a school was polled, clearing its aging counter. */
  recordPolled(schoolId) {
    this.cyclesDeferred.delete(schoolId);
  }

  /** Consecutive cycles a school has been deferred. */
  getDeferralCount(schoolId) {
    return this.cyclesDeferred.get(schoolId) || 0;
  }

  /**
   * Worst observed staleness in cycles, across all currently-deferred schools.
   * This is the figure the documented SLA is measured against.
   */
  getMaxDeferralCycles() {
    let max = 0;
    for (const count of this.cyclesDeferred.values()) {
      if (count > max) max = count;
    }
    return max;
  }

  getStats() {
    return {
      nominalBudget: this.nominalBudget,
      currentCeiling: this.currentCeiling,
      remaining: this.remaining,
      consumedThisCycle: this.consumedThisCycle,
      deniedThisCycle: this.deniedThisCycle,
      rateLimitEventsThisCycle: this.rateLimitEventsThisCycle,
      deferredSchools: this.cyclesDeferred.size,
      maxDeferralCycles: this.getMaxDeferralCycles(),
      cycles: this.cycles,
    };
  }
}

module.exports = {
  HorizonPollBudget,
  computeCycleBudget,
  computeSchoolPriority,
  orderSchoolsByPriority,
  // Exposed so tests and docs can assert against the same constants.
  HORIZON_RATE_LIMIT_PER_HOUR,
  POLL_BUDGET_SAFETY_FACTOR,
  MIN_BUDGET_PER_CYCLE,
  PRIORITY_PENDING_PAYMENT,
  PRIORITY_NEVER_SYNCED,
  PRIORITY_AGING_PER_CYCLE,
  RECENT_ACTIVITY_WINDOW_MS,
};
