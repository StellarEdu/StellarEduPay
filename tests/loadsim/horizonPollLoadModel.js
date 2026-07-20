'use strict';

/**
 * Discrete-event load model for Horizon polling under rate-limit pressure (#1124).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a MODEL, not a test against live Horizon. It exists because the
 * headline claim of #1124 — that coordinated budgeting reduces worst-case sync
 * delay versus independent per-school polling — is a claim about behaviour at a
 * school count we cannot provision in CI, under a rate limit we do not control.
 *
 * A model can be wrong, so it is written to be checkable. It encodes exactly
 * four mechanisms, each of which is a real, verifiable property of the system:
 *
 *   1. Horizon enforces a fixed request allowance per unit time; requests beyond
 *      it return 429 and return no data. This is Horizon's documented behaviour.
 *
 *   2. Under the OLD strategy every school polls independently and
 *      simultaneously (`Promise.allSettled(schools.map(...))` with no shared
 *      accounting), so aggregate demand is the unbounded sum of per-school
 *      demand. This is what the code did before this change.
 *
 *   3. A 429 anywhere triggers CYCLE-LEVEL exponential backoff that slows
 *      polling for EVERY school, including ones that were never rate-limited
 *      and have parents waiting. This is the `consecutiveErrors` /
 *      POLL_MAX_BACKOFF_MS logic in transactionPollingService.
 *
 *   4. Under the NEW strategy, demand is capped at a budget below the limit and
 *      spent in priority order, so 429s (and therefore the global backoff in 3)
 *      do not occur, and the schools that do get served are the ones with
 *      payments outstanding.
 *
 * Mechanism 3 is the crux, and it is why the improvement is large rather than
 * marginal: under the old strategy the penalty for overshooting is not just
 * wasted requests, it is a system-wide slowdown that punishes the schools that
 * least deserve it.
 *
 * The model deliberately does NOT flatter the new strategy: it gives the new
 * strategy a *smaller* raw allowance (the safety factor holds it below the true
 * limit, reserving headroom for user-facing verify calls), so any improvement
 * comes from coordination and ordering, not from being handed more capacity.
 */

const {
  HorizonPollBudget,
  orderSchoolsByPriority,
} = require('../../backend/src/services/horizonPollBudget');

/**
 * Deterministic PRNG (mulberry32) so every run is byte-identical and any
 * failure is reproducible from the seed alone.
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a fleet of schools with a start-of-term payment arrival pattern:
 * a minority of schools are extremely busy, most are quiet. Payment arrivals
 * are Poisson-ish per cycle.
 *
 * @returns {Array<object>} school records with a per-cycle arrival rate
 */
function buildFleet({ schoolCount, seed = 1124, spikeFraction = 0.25, spikeMultiplier = 12 }) {
  const rng = makeRng(seed);
  const fleet = [];

  for (let i = 0; i < schoolCount; i++) {
    const isSpiking = rng() < spikeFraction;
    // Baseline: most schools see well under one payment per cycle.
    const baseRate = 0.15 + rng() * 0.35;
    fleet.push({
      schoolId: `SCH${String(i).padStart(4, '0')}`,
      // Every school is already onboarded and has synced before, so the
      // never-synced priority bonus doesn't skew the comparison.
      syncCursor: `cursor-${i}`,
      arrivalRate: isSpiking ? baseRate * spikeMultiplier : baseRate,
      isSpiking,
    });
  }

  return fleet;
}

/**
 * Sample a per-cycle arrival count from a rate, using a simple inversion of the
 * Poisson CDF. Kept inline (rather than pulling a stats dependency) so the model
 * has no dependencies beyond the module under test.
 */
function samplePoisson(rate, rng) {
  const L = Math.exp(-rate);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/**
 * Run the simulation.
 *
 * @param {object} opts
 * @param {'independent'|'coordinated'} opts.strategy
 * @param {Array<object>} opts.fleet
 * @param {number} opts.cycles - Number of poll cycles to simulate
 * @param {number} opts.intervalMs - Base poll interval
 * @param {number} opts.horizonLimitPerCycle - Hard request allowance per cycle
 * @param {number} [opts.txPerPage] - Transactions returned per Horizon page
 * @param {number} [opts.seed]
 * @returns {object} delay statistics in milliseconds
 */
function simulate({
  strategy,
  fleet,
  cycles,
  intervalMs,
  horizonLimitPerCycle,
  txPerPage = 20,
  seed = 99,
}) {
  const rng = makeRng(seed);

  // Per-school queue of payments waiting to be picked up, each stamped with the
  // simulated time it landed on-chain.
  const backlog = new Map(fleet.map(s => [s.schoolId, []]));
  const completedDelays = [];
  // Delays restricted to schools that had payments pending — the population
  // whose experience the SLA is actually about.
  let rateLimitEvents = 0;
  let wastedRequests = 0;
  let totalRequests = 0;

  // Cycle-level backoff state, mirroring transactionPollingService.
  let consecutiveErrors = 0;
  const POLL_MAX_BACKOFF_MS = 300000;

  const budget = strategy === 'coordinated'
    ? new HorizonPollBudget({
        intervalMs,
        // Give the coordinated strategy LESS than the true limit — the safety
        // factor reserves headroom for user-facing verify traffic. Any win must
        // therefore come from coordination, not extra capacity.
        budgetOverride: Math.max(1, Math.floor(horizonLimitPerCycle * 0.6)),
      })
    : null;

  let now = 0;

  for (let cycle = 0; cycle < cycles; cycle++) {
    // Effective interval reflects the global exponential backoff. Note this
    // applies to BOTH strategies — but only the independent one ever triggers
    // it, because only it overshoots the limit.
    const effectiveInterval = consecutiveErrors > 0
      ? Math.min(intervalMs * 2 ** consecutiveErrors, POLL_MAX_BACKOFF_MS)
      : intervalMs;

    now += effectiveInterval;

    // ── Arrivals ──────────────────────────────────────────────────────────
    for (const school of fleet) {
      const arrivals = samplePoisson(school.arrivalRate, rng);
      const queue = backlog.get(school.schoolId);
      for (let i = 0; i < arrivals; i++) queue.push(now);
    }

    // ── Polling ───────────────────────────────────────────────────────────
    let requestsThisCycle = 0;
    let sawRateLimit = false;

    /**
     * Issue one Horizon page request. Beyond the hard limit Horizon returns
     * 429: the quota is still spent, but no data comes back.
     * @returns {boolean} whether the request returned data
     */
    function issueRequest() {
      requestsThisCycle++;
      totalRequests++;
      if (requestsThisCycle > horizonLimitPerCycle) {
        sawRateLimit = true;
        rateLimitEvents++;
        wastedRequests++;
        return false;
      }
      return true;
    }

    /** Drain up to `maxPages` pages of a school's backlog. */
    function drainSchool(schoolId, maxPages, consumeBudget) {
      const queue = backlog.get(schoolId);
      for (let page = 0; page < maxPages; page++) {
        if (queue.length === 0) break;
        if (consumeBudget && !budget.tryConsume(1)) return 'budget_exhausted';
        if (!issueRequest()) return 'rate_limited';

        const taken = queue.splice(0, txPerPage);
        for (const arrivedAt of taken) completedDelays.push(now - arrivedAt);
      }
      return 'ok';
    }

    if (strategy === 'independent') {
      // Every school polls at once, each assuming the whole limit is its own.
      // No ordering: Mongo's natural order, modelled as fleet order.
      for (const school of fleet) {
        const queue = backlog.get(school.schoolId);
        if (queue.length === 0) continue;
        const pagesNeeded = Math.ceil(queue.length / txPerPage);
        drainSchool(school.schoolId, Math.min(pagesNeeded, 50), false);
      }
    } else {
      budget.startCycle();

      // Priority signals come from the same function production uses.
      const signals = new Map(fleet.map(s => [s.schoolId, {
        pendingCount: backlog.get(s.schoolId).length,
        lastActivityAt: null,
        cyclesDeferred: budget.getDeferralCount(s.schoolId),
      }]));

      const ordered = orderSchoolsByPriority(fleet, signals, now);

      for (const { school } of ordered) {
        const queue = backlog.get(school.schoolId);
        if (queue.length === 0) {
          budget.recordPolled(school.schoolId);
          continue;
        }
        const pagesNeeded = Math.ceil(queue.length / txPerPage);
        const outcome = drainSchool(school.schoolId, Math.min(pagesNeeded, 50), true);
        if (outcome === 'budget_exhausted') {
          budget.recordDeferred(school.schoolId);
        } else {
          budget.recordPolled(school.schoolId);
        }
      }

      if (sawRateLimit) budget.recordRateLimited();
    }

    // ── Global backoff, exactly as the poller applies it ──────────────────
    if (sawRateLimit) {
      consecutiveErrors++;
    } else {
      consecutiveErrors = 0;
    }
  }

  // Anything still queued at the end has waited at least this long. Including
  // it prevents the model from flattering a strategy that simply never gets to
  // a school — an omission that would hide exactly the starvation we care about.
  const unresolved = [];
  for (const queue of backlog.values()) {
    for (const arrivedAt of queue) unresolved.push(now - arrivedAt);
  }

  const allDelays = completedDelays.concat(unresolved).sort((a, b) => a - b);
  const pct = (p) => allDelays.length
    ? allDelays[Math.min(allDelays.length - 1, Math.floor(allDelays.length * p))]
    : 0;

  return {
    strategy,
    samples: allDelays.length,
    resolved: completedDelays.length,
    unresolved: unresolved.length,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: allDelays.length ? allDelays[allDelays.length - 1] : 0,
    rateLimitEvents,
    wastedRequests,
    totalRequests,
    finalIntervalMs: consecutiveErrors > 0
      ? Math.min(intervalMs * 2 ** consecutiveErrors, POLL_MAX_BACKOFF_MS)
      : intervalMs,
  };
}

module.exports = { buildFleet, simulate, makeRng };
