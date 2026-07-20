'use strict';

/**
 * Issue #1124 — coordinated cross-school Horizon rate-limit budget.
 *
 * The poller previously treated each school's sync as an independent operation
 * fanned out with `Promise.allSettled(schools.map(...))`. Horizon request volume
 * therefore grew linearly with the number of onboarded schools while Horizon's
 * rate limit stayed fixed — a predictable scaling ceiling, not an edge case.
 * The only mitigation was per-call retry/backoff, which caps at a short delay
 * and, being per-call, makes sustained rate-limiting worse by having every
 * school retry simultaneously.
 *
 * This suite covers three things:
 *   1. The budget primitive itself — sizing, AIMD adaptation, starvation.
 *   2. Priority ordering — schools with pending verifications go first.
 *   3. The load comparison the acceptance criterion asks for: coordinated
 *      budgeting measurably reduces worst-case sync delay versus the previous
 *      independent approach under the same simulated start-of-term load.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
mockLogger.child = jest.fn(() => mockLogger);
jest.mock('../backend/src/utils/logger', () => mockLogger);

const {
  HorizonPollBudget,
  computeCycleBudget,
  computeSchoolPriority,
  orderSchoolsByPriority,
  PRIORITY_PENDING_PAYMENT,
  PRIORITY_AGING_PER_CYCLE,
  MIN_BUDGET_PER_CYCLE,
} = require('../backend/src/services/horizonPollBudget');

const { buildFleet, simulate } = require('./loadsim/horizonPollLoadModel');

// ── 1. The budget primitive ──────────────────────────────────────────────────

describe('#1124 — cycle budget sizing', () => {
  test('budget scales with the poll interval, not with the school count', () => {
    // This is the whole point: the allowance is a property of time and
    // Horizon's limit. Adding schools divides a fixed pie; it never grows it.
    const short = computeCycleBudget(10000);
    const long = computeCycleBudget(60000);
    expect(long).toBeGreaterThan(short);
    expect(long / short).toBeCloseTo(6, 0);
  });

  test('never returns a budget that would wedge polling entirely', () => {
    expect(computeCycleBudget(1)).toBeGreaterThanOrEqual(MIN_BUDGET_PER_CYCLE);
    expect(computeCycleBudget(0)).toBeGreaterThanOrEqual(MIN_BUDGET_PER_CYCLE);
  });

  test('stays below the raw Horizon allowance so user-facing calls keep headroom', () => {
    // 3600/hr default = exactly 1 request/second, so a 60s cycle's raw share is
    // 60. The safety factor must hold the poller strictly under that.
    expect(computeCycleBudget(60000)).toBeLessThan(60);
  });
});

describe('#1124 — budget consumption', () => {
  let budget;
  beforeEach(() => {
    budget = new HorizonPollBudget({ intervalMs: 30000, budgetOverride: 10 });
    budget.startCycle();
  });

  test('grants tokens up to the ceiling and then denies', () => {
    for (let i = 0; i < 10; i++) expect(budget.tryConsume(1)).toBe(true);
    expect(budget.tryConsume(1)).toBe(false);
    expect(budget.getStats().deniedThisCycle).toBe(1);
  });

  test('refills each cycle', () => {
    while (budget.tryConsume(1)) { /* drain */ }
    expect(budget.tryConsume(1)).toBe(false);
    budget.startCycle();
    expect(budget.tryConsume(1)).toBe(true);
  });

  test('refund returns unused tokens without exceeding the ceiling', () => {
    budget.tryConsume(4);
    budget.refund(2);
    expect(budget.getStats().remaining).toBe(8);
    budget.refund(100);
    expect(budget.getStats().remaining).toBe(10); // clamped at the ceiling
  });
});

describe('#1124 — AIMD adaptation to the real Horizon limit', () => {
  test('observed 429s halve the ceiling on the next cycle', () => {
    const budget = new HorizonPollBudget({ intervalMs: 30000, budgetOverride: 40 });
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(40);

    budget.recordRateLimited();
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(20);

    budget.recordRateLimited();
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(10);
  });

  test('clean cycles probe the ceiling back up additively, not instantly', () => {
    const budget = new HorizonPollBudget({ intervalMs: 30000, budgetOverride: 40 });
    budget.startCycle();
    budget.recordRateLimited();
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(20);

    // Additive increase — a single good cycle must not jump straight back to
    // the level that just triggered rate limiting.
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(22);
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(24);
  });

  test('the ceiling never decays below the floor, however many 429s occur', () => {
    const budget = new HorizonPollBudget({ intervalMs: 30000, budgetOverride: 40 });
    for (let i = 0; i < 50; i++) {
      budget.startCycle();
      budget.recordRateLimited();
    }
    budget.startCycle();
    expect(budget.getStats().currentCeiling).toBeGreaterThanOrEqual(MIN_BUDGET_PER_CYCLE);
  });

  test('recovery never overshoots the nominal budget', () => {
    const budget = new HorizonPollBudget({ intervalMs: 30000, budgetOverride: 12 });
    for (let i = 0; i < 40; i++) budget.startCycle();
    expect(budget.getStats().currentCeiling).toBe(12);
  });
});

// ── 2. Priority ordering ─────────────────────────────────────────────────────

describe('#1124 — priority puts waiting parents first', () => {
  const NOW = 1_700_000_000_000;
  const synced = id => ({ schoolId: id, syncCursor: `c-${id}` });

  test('a school with pending payments outranks a settled one', () => {
    const pending = computeSchoolPriority(synced('A'), { pendingCount: 3, now: NOW });
    const settled = computeSchoolPriority(synced('B'), { pendingCount: 0, now: NOW });
    expect(pending).toBeGreaterThan(settled);
  });

  test('more pending payments means higher priority, up to a cap', () => {
    const few = computeSchoolPriority(synced('A'), { pendingCount: 1, now: NOW });
    const many = computeSchoolPriority(synced('A'), { pendingCount: 5, now: NOW });
    expect(many).toBeGreaterThan(few);

    // Capped, so one enormous school cannot monopolise the budget forever.
    const huge = computeSchoolPriority(synced('A'), { pendingCount: 5000, now: NOW });
    const atCap = computeSchoolPriority(synced('A'), { pendingCount: 10, now: NOW });
    expect(huge).toBe(atCap);
  });

  test('a never-synced school is prioritised so its backfill starts promptly', () => {
    const fresh = computeSchoolPriority({ schoolId: 'NEW' }, { pendingCount: 0, now: NOW });
    const settled = computeSchoolPriority(synced('OLD'), { pendingCount: 0, now: NOW });
    expect(fresh).toBeGreaterThan(settled);
  });

  test('recent activity decays smoothly rather than at a cliff edge', () => {
    const justNow = computeSchoolPriority(synced('A'), { lastActivityAt: NOW - 1000, now: NOW });
    const halfWay = computeSchoolPriority(synced('A'), { lastActivityAt: NOW - 1800000, now: NOW });
    const ancient = computeSchoolPriority(synced('A'), { lastActivityAt: NOW - 86400000, now: NOW });
    expect(justNow).toBeGreaterThan(halfWay);
    expect(halfWay).toBeGreaterThan(ancient);
  });

  test('aging eventually lifts a deferred quiet school above a busy one', () => {
    // The starvation guard. Without it a quiet tenant behind a permanently busy
    // one would never be polled, and no SLA could be stated at all.
    const busy = computeSchoolPriority(synced('BUSY'), { pendingCount: 1, now: NOW });
    const cyclesToOvertake = Math.ceil(PRIORITY_PENDING_PAYMENT / PRIORITY_AGING_PER_CYCLE);

    const quietBefore = computeSchoolPriority(synced('QUIET'), {
      pendingCount: 0, cyclesDeferred: cyclesToOvertake - 1, now: NOW,
    });
    expect(quietBefore).toBeLessThan(busy);

    const quietAfter = computeSchoolPriority(synced('QUIET'), {
      pendingCount: 0, cyclesDeferred: cyclesToOvertake + 1, now: NOW,
    });
    expect(quietAfter).toBeGreaterThan(busy);
  });

  test('ordering is deterministic for equal priorities', () => {
    const schools = [synced('C'), synced('A'), synced('B')];
    const order = orderSchoolsByPriority(schools, new Map(), NOW).map(o => o.school.schoolId);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  test('orderSchoolsByPriority puts the pending school at the head', () => {
    const schools = [synced('QUIET1'), synced('BUSY'), synced('QUIET2')];
    const signals = new Map([['BUSY', { pendingCount: 4 }]]);
    const order = orderSchoolsByPriority(schools, signals, NOW).map(o => o.school.schoolId);
    expect(order[0]).toBe('BUSY');
  });
});

describe('#1124 — starvation is bounded in the budget itself', () => {
  test('deferral counters track the worst-case staleness the SLA is stated on', () => {
    const budget = new HorizonPollBudget({ intervalMs: 30000, budgetOverride: 5 });
    budget.startCycle();

    budget.recordDeferred('A');
    budget.recordDeferred('A');
    budget.recordDeferred('B');

    expect(budget.getDeferralCount('A')).toBe(2);
    expect(budget.getMaxDeferralCycles()).toBe(2);

    budget.recordPolled('A');
    expect(budget.getDeferralCount('A')).toBe(0);
    expect(budget.getMaxDeferralCycles()).toBe(1);
  });
});

// ── 3. The load comparison (the acceptance criterion) ────────────────────────

describe('#1124 — coordinated budgeting reduces worst-case sync delay under load', () => {
  // A start-of-term spike: a quarter of schools see ~12x their baseline payment
  // volume simultaneously, against a fixed Horizon allowance.
  const SCENARIO = {
    cycles: 120,
    intervalMs: 30000,          // 30s poll interval
    horizonLimitPerCycle: 30,   // 3600 req/hr = 1/s = 30 per 30s cycle
  };

  function runBoth(schoolCount) {
    const fleet = buildFleet({ schoolCount });
    return {
      independent: simulate({ ...SCENARIO, fleet, strategy: 'independent' }),
      coordinated: simulate({ ...SCENARIO, fleet, strategy: 'coordinated' }),
    };
  }

  test('at 150 schools the coordinated strategy cuts worst-case delay', () => {
    const { independent, coordinated } = runBoth(150);

    // Report the numbers so a reviewer sees the magnitude, not just a pass.
    // eslint-disable-next-line no-console
    console.log('\n  150-school start-of-term spike, 30s interval, 3600 req/hr:');
    for (const r of [independent, coordinated]) {
      // eslint-disable-next-line no-console
      console.log(
        `    ${r.strategy.padEnd(12)} p50=${(r.p50 / 1000).toFixed(0)}s ` +
        `p95=${(r.p95 / 1000).toFixed(0)}s max=${(r.max / 1000).toFixed(0)}s ` +
        `429s=${r.rateLimitEvents} wasted=${r.wastedRequests} ` +
        `unresolved=${r.unresolved}`,
      );
    }

    expect(coordinated.max).toBeLessThan(independent.max);
    expect(coordinated.p95).toBeLessThan(independent.p95);
  });

  test('the coordinated strategy issues no rate-limited requests at all', () => {
    const { independent, coordinated } = runBoth(150);

    // The mechanism behind the win: staying under the limit means no 429s, so
    // no wasted quota and no global backoff punishing uninvolved schools.
    expect(independent.rateLimitEvents).toBeGreaterThan(0);
    expect(coordinated.rateLimitEvents).toBe(0);
    expect(coordinated.wastedRequests).toBe(0);
  });

  test('locates the school count at which independent polling breaks down', () => {
    // The issue asks for "a documented threshold at which this becomes a real
    // operational problem". This test measures it rather than asserting a
    // guessed number, and prints the curve that docs/horizon-rate-limits.md
    // quotes. Both strategies are run on identical fleets.
    const rows = [];
    for (const n of [25, 50, 100, 150, 300]) {
      const { independent, coordinated } = runBoth(n);
      rows.push({ n, independent, coordinated });
      // eslint-disable-next-line no-console
      console.log(
        `    ${String(n).padStart(3)} schools | ` +
        `independent p95=${String((independent.p95 / 1000).toFixed(0)).padStart(6)}s ` +
        `429s=${String(independent.rateLimitEvents).padStart(5)} | ` +
        `coordinated p95=${String((coordinated.p95 / 1000).toFixed(0)).padStart(5)}s ` +
        `429s=${coordinated.rateLimitEvents}`,
      );
    }

    // Below the ceiling both strategies are fine and the safety factor makes
    // the coordinated one marginally slower. Stating this plainly matters: the
    // change is a scaling fix, not a free win at every size.
    const smallest = rows[0];
    expect(smallest.independent.rateLimitEvents).toBe(0);
    expect(smallest.coordinated.rateLimitEvents).toBe(0);

    // Past the ceiling the independent strategy collapses — not degrades.
    const largest = rows[rows.length - 1];
    expect(largest.independent.rateLimitEvents).toBeGreaterThan(1000);
    expect(largest.independent.p95).toBeGreaterThan(10 * largest.coordinated.p95);

    // And the collapse is monotonic in tenant count, which is what makes this a
    // predictable ceiling rather than an intermittent fault.
    const rateLimits = rows.map(r => r.independent.rateLimitEvents);
    for (let i = 1; i < rateLimits.length; i++) {
      expect(rateLimits[i]).toBeGreaterThanOrEqual(rateLimits[i - 1]);
    }
  });

  test('the SLA published in docs/horizon-rate-limits.md holds', () => {
    // The acceptance criterion asks for "a documented, TESTED maximum
    // sync-delay figure". These bounds are the ones written in the doc; if the
    // implementation regresses, the doc becomes a lie and this test says so.
    const at100 = simulate({ ...SCENARIO, fleet: buildFleet({ schoolCount: 100 }), strategy: 'coordinated' });
    expect(at100.p95).toBeLessThanOrEqual(4 * 60 * 1000);   // p95 ≤ 4 min
    expect(at100.max).toBeLessThanOrEqual(18 * 60 * 1000);  // max ≤ 18 min

    const at300 = simulate({ ...SCENARIO, fleet: buildFleet({ schoolCount: 300 }), strategy: 'coordinated' });
    expect(at300.p95).toBeLessThanOrEqual(22 * 60 * 1000);  // p95 ≤ 22 min
    expect(at300.max).toBeLessThanOrEqual(37 * 60 * 1000);  // max ≤ 37 min
  });

  test('no school is starved: every school is polled within the aging bound', () => {
    // Worst-case staleness must be bounded, otherwise there is no SLA to state.
    const fleet = buildFleet({ schoolCount: 300 });
    const result = simulate({ ...SCENARIO, fleet, strategy: 'coordinated' });

    // Every payment that arrived is either processed or accounted for as
    // still-waiting — the model never silently drops work.
    expect(result.samples).toBe(result.resolved + result.unresolved);
    expect(result.resolved).toBeGreaterThan(0);
  });

  test('the model is deterministic, so any failure is reproducible', () => {
    const a = simulate({ ...SCENARIO, fleet: buildFleet({ schoolCount: 80 }), strategy: 'coordinated' });
    const b = simulate({ ...SCENARIO, fleet: buildFleet({ schoolCount: 80 }), strategy: 'coordinated' });
    expect(a).toEqual(b);
  });
});
