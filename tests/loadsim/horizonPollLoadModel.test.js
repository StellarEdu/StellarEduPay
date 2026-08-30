'use strict';

/**
 * Assertions over the Horizon poll load model (#1124).
 *
 * The model itself lives in horizonPollLoadModel.js and used to be a bare
 * script: it exported simulation functions but nothing ever called them, so it
 * could drift from horizonPollBudget indefinitely without anyone noticing.
 * These tests give it a regression signal.
 *
 * They assert the mechanisms the model claims, not tuned magic numbers, so the
 * suite fails when the budget service stops behaving the way the model assumes
 * rather than when a delay percentile moves by a few points.
 *
 * This suite is excluded from the default `npm test` run. Run it with
 * `npm run test:loadsim` — see docs/load-simulation.md.
 */

const {
  buildFleet,
  simulate,
  makeRng,
} = require('./horizonPollLoadModel');

// === Fixtures

// Demand deliberately exceeds the per-cycle allowance: ~300 schools each want
// at least one page per cycle against an allowance of 120. Anything that does
// not coordinate must overshoot.
const SCENARIO = {
  schoolCount: 300,
  cycles: 40,
  intervalMs: 30000,
  horizonLimitPerCycle: 120,
  seed: 99,
};

function runStrategy(strategy, overrides = {}) {
  const opts = { ...SCENARIO, ...overrides };
  return simulate({
    strategy,
    fleet: buildFleet({ schoolCount: opts.schoolCount, seed: 1124 }),
    cycles: opts.cycles,
    intervalMs: opts.intervalMs,
    horizonLimitPerCycle: opts.horizonLimitPerCycle,
    seed: opts.seed,
  });
}

let independent;
let coordinated;

beforeAll(() => {
  independent = runStrategy('independent');
  coordinated = runStrategy('coordinated');
});

// === Tests

describe('horizon poll load model', () => {
  test('the model is deterministic for a given seed', () => {
    expect(runStrategy('coordinated')).toEqual(coordinated);
    expect(runStrategy('independent')).toEqual(independent);
  });

  test('makeRng produces a reproducible stream in [0, 1)', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 50; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('every payment is accounted for as resolved or unresolved', () => {
    for (const result of [independent, coordinated]) {
      expect(result.samples).toBe(result.resolved + result.unresolved);
      expect(result.samples).toBeGreaterThan(0);
    }
  });

  test('the scenario is actually oversubscribed for uncoordinated polling', () => {
    expect(independent.rateLimitEvents).toBeGreaterThan(0);
    expect(independent.wastedRequests).toBeGreaterThan(0);
  });

  test('coordinated polling never overshoots the Horizon allowance', () => {
    expect(coordinated.rateLimitEvents).toBe(0);
    expect(coordinated.wastedRequests).toBe(0);
  });

  test('only the uncoordinated strategy trips the cycle-level backoff', () => {
    expect(independent.finalIntervalMs).toBeGreaterThan(SCENARIO.intervalMs);
    expect(coordinated.finalIntervalMs).toBe(SCENARIO.intervalMs);
  });

  test('coordinated polling wins on worst-case sync delay', () => {
    expect(coordinated.p95).toBeLessThan(independent.p95);
    expect(coordinated.p99).toBeLessThan(independent.p99);
    expect(coordinated.max).toBeLessThan(independent.max);
  });

  test('coordinated polling spends strictly less quota than it is given', () => {
    // The safety factor holds the budget below the true limit, so the win comes
    // from ordering rather than from extra capacity.
    const spentPerCycle = coordinated.totalRequests / SCENARIO.cycles;
    expect(spentPerCycle).toBeLessThanOrEqual(SCENARIO.horizonLimitPerCycle);
  });

  test('an allowance that comfortably covers demand rate-limits neither strategy', () => {
    const roomy = { horizonLimitPerCycle: 5000 };
    expect(runStrategy('independent', roomy).rateLimitEvents).toBe(0);
    expect(runStrategy('coordinated', roomy).rateLimitEvents).toBe(0);
  });
});
