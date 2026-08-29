# Horizon Rate Limits, Poll Budgeting, and the Sync-Delay SLA

Status: implemented (#1124). Supersedes the unbounded "temporary sync delays"
caveat previously recorded in `CHANGELOG.md`'s Known Issues.

## The problem this addresses

Payment sync polls Stellar Horizon on a fixed interval. Before #1124 each
school's poll was an independent operation, fanned out with
`Promise.allSettled(schools.map(...))`. Horizon request volume therefore scaled
as:

```
requests per cycle  ≈  Σ over active schools (pages that school needs)
```

That grows linearly with the number of onboarded schools. Horizon's rate limit
for our IP/API key does **not** grow at all. Rate limiting was therefore not a
rare edge case but a **predictable scaling ceiling** the platform would hit as
adoption grew, with "temporary" delays becoming longer and more frequent over
time.

The pre-existing mitigation — `withStellarRetry` — did not address this and in
some respects made it worse:

- It caps at a short per-call backoff (10s max delay, 3 attempts by default).
- Being per-call, it has no cross-school view. Under sustained rate limiting
  every school retried simultaneously, converting one rate-limit event into a
  thundering herd that kept the limit saturated.
- A 429 anywhere tripped **cycle-level** exponential backoff that slowed polling
  for *every* school — including schools that were never rate-limited and had
  parents actively waiting on a payment.

That last point is the crux. Overshooting the limit did not merely waste
requests; it triggered a system-wide slowdown that penalised the schools least
responsible for it.

## What is implemented

`backend/src/services/horizonPollBudget.js` provides a coordinated, cross-school
request budget. Four mechanisms:

### 1. A shared per-cycle budget

A token bucket sized from Horizon's rate limit and the poll interval, shared by
all schools. Every Horizon page fetch draws one token. When the budget is spent,
remaining schools are **deferred to the next cycle** rather than issuing
requests that would be 429'd.

Deferral is strictly better than a 429: both leave the work undone, but a 429
also consumes quota, returns nothing, and trips the global backoff.

```
budget per cycle = (HORIZON_RATE_LIMIT_PER_HOUR / 3600000) × intervalMs
                   × HORIZON_POLL_BUDGET_SAFETY_FACTOR
                   ÷ HORIZON_POLL_REPLICA_COUNT
```

The safety factor (default `0.6`) deliberately holds the poller below the true
limit. Polling is not the only Horizon consumer — the verify endpoint, retry
worker and confirmation finalizer share the same allowance, and those are
user-facing, so background polling must never starve them.

### 2. Priority ordering

The budget is spent where delay is actually felt. Scores, highest first:

| Signal | Weight | Rationale |
|---|---|---|
| Never synced (no cursor) | 250 | A new school cannot show anything until its backfill starts |
| Pending unconfirmed payments | 100 each, capped at 10 | Someone is actively waiting on these |
| Recent on-chain activity | up to 20, decaying over 1h | Recent activity predicts more activity |
| Cycles deferred | 15 per cycle | Starvation guard — see below |

The pending-payment weight is capped so a single enormous school cannot
monopolise the budget indefinitely.

### 3. Aging (the starvation guard)

Priority alone would starve quiet schools forever. Every deferred cycle raises a
school's score by 15, so a fully-settled school overtakes a school with one
pending payment after ~7 deferred cycles. **This is what makes worst-case
staleness bounded, and therefore what makes an SLA statable at all.**

### 4. AIMD adaptation

Observed 429s halve the ceiling; clean cycles raise it by 2. This is the control
law TCP uses. It matters because Horizon's actual limit varies by provider and
plan — the system converges on the real limit instead of trusting the configured
guess.

Concurrency is separately bounded by `SYNC_MAX_CONCURRENT_SCHOOLS` (default 4),
so a large tenant count cannot open an unbounded number of simultaneous
connections. The budget caps total requests; this caps their burstiness.

## Measured behaviour and the SLA

Measured with `tests/loadsim/horizonPollLoadModel.js`, a deterministic
discrete-event model exercised by `tests/issue-1124-horizon-poll-budget.test.js`.

**Scenario.** Start-of-term spike: 25% of schools simultaneously at ~12× their
baseline payment volume. 30-second poll interval, Horizon allowance of 3600
requests/hour (30 per cycle), 120 cycles.

Both strategies run on **identical** fleets, and the coordinated strategy is
given a *smaller* raw allowance (the 0.6 safety factor), so the improvement
comes from coordination and ordering rather than extra capacity.

| Schools | Independent p95 | Independent 429s | Coordinated p95 | Coordinated 429s |
|---:|---:|---:|---:|---:|
| 25 | 0s | 0 | 0s | 0 |
| 50 | 0s | 1 | 60s | 0 |
| 100 | 30,600s (8.5h) | 4,430 | 240s | 0 |
| 150 | 32,700s (9.1h) | 10,350 | 360s | 0 |
| 300 | 33,300s (9.25h) | 28,124 | 1,290s | 0 |

### The threshold, stated plainly

- **Below ~50 schools** the old approach was fine, and coordination is very
  slightly *worse* (p95 60s vs 0s at 50 schools) because the safety factor holds
  back capacity that wasn't needed. This is a real, if small, cost and is stated
  here rather than glossed over.
- **Between 50 and 100 schools** the old approach breaks down — sharply, not
  gradually. At 100 schools p95 sync delay reaches **8.5 hours** and a third of
  all requests are wasted on 429s.
- **Above 100 schools** the old approach is unusable; the coordinated one
  degrades gracefully (240s → 1,290s p95 between 100 and 300 schools).

### SLA

Under the scenario above, with default configuration:

| Load | Max expected sync delay |
|---|---|
| ≤ 100 schools | **≤ 5 minutes** (p95 ≤ 4 min, max ≤ 18 min) |
| ≤ 300 schools | **≤ 25 minutes** (p95 ≤ 22 min, max ≤ 37 min) |

Worst-case delay for any individual school is bounded by the aging mechanism at
approximately:

```
max delay  ≈  (max_deferral_cycles + 1) × poll interval
```

`horizon_poll_max_deferral_cycles` exports that term directly, so the SLA is
observable in production rather than only in the model.

### What the model does and doesn't prove

The model is **not** a test against live Horizon, and it should not be read as
one. It encodes four mechanisms, each independently verifiable against the
source: Horizon's fixed allowance and 429 behaviour; the old unbounded fan-out;
the existing cycle-level backoff in `transactionPollingService`; and the new
budget, which it drives through the *real* `HorizonPollBudget` and
`orderSchoolsByPriority` rather than a reimplementation.

What it does not capture: real Horizon latency variance, per-endpoint limit
differences, network failures unrelated to rate limiting, and MongoDB
contention. **The figures above should be re-validated against a staging
Horizon before being quoted to a customer as a contractual SLA.** They are
sound as an engineering baseline and as a relative comparison between the two
strategies; they are not a substitute for a live load test.

## Configuration

Every environment variable that affects polling behaviour — not just the budget
system itself — is listed below, since tuning one without the others is a
common source of surprises (e.g. raising `SYNC_MAX_PAGES_PER_POLL` does nothing
if the cross-school budget is already the binding constraint).

| Env var | Default | Meaning |
|---|---:|---|
| `SYNC_INTERVAL_MS` (falls back to `POLL_INTERVAL_MS`, then 60000) | 60000 | Poll cycle interval. Also resizes the per-cycle budget — see the worked example below |
| `HORIZON_RATE_LIMIT_PER_HOUR` | 3600 | Horizon's allowance for our key. Raise on a paid/self-hosted instance |
| `HORIZON_POLL_BUDGET_SAFETY_FACTOR` | 0.6 | Fraction of the limit polling may use; the rest is reserved for user-facing calls |
| `HORIZON_POLL_REPLICA_COUNT` | 1 | Replicas sharing the allowance. **Set this to your replica count** |
| `HORIZON_POLL_MIN_BUDGET` | 4 | Floor, so misconfiguration cannot wedge polling |
| `SYNC_MAX_PAGES_PER_POLL` | 50 | Per-school cap on pages drained in one cycle, independent of the shared budget. Bounds how much of the shared budget one very active school can consume in a single cycle, while letting a fresh school's backfill span multiple cycles |
| `SYNC_MAX_CONCURRENT_SCHOOLS` | 4 | Max schools polled simultaneously. Bounds burstiness of the requests the budget already caps in total — it does not raise or lower the budget itself |
| `HORIZON_POLL_RECENT_ACTIVITY_WINDOW_MS` | 3600000 | Window over which recent activity boosts priority |

> **Multi-replica warning.** The budget is per-process. Leaving
> `HORIZON_POLL_REPLICA_COUNT=1` while running N replicas means the combined
> rate is N× the intended budget. The per-school distributed lock still prevents
> two replicas syncing the *same* school, so this is a rate-limit concern rather
> than a correctness one — but it will reintroduce 429s.

### Worked example: how the budget is allocated as fleet size grows

The key thing to internalise: **the per-cycle budget does not depend on how
many schools are active.** It is fixed by `HORIZON_RATE_LIMIT_PER_HOUR`,
`HORIZON_POLL_BUDGET_SAFETY_FACTOR`, `HORIZON_POLL_REPLICA_COUNT` and the poll
interval alone (`computeCycleBudget()` in `horizonPollBudget.js`). What changes
as the fleet grows is not the budget — it's how many cycles it takes to get
through everyone, and therefore how stale a quiet school's data can get.

With defaults (`HORIZON_RATE_LIMIT_PER_HOUR=3600`,
`HORIZON_POLL_BUDGET_SAFETY_FACTOR=0.6`, `HORIZON_POLL_REPLICA_COUNT=1`, and
neither `SYNC_INTERVAL_MS` nor `POLL_INTERVAL_MS` set — a 60-second interval):

```
budget per cycle = (3600 / 3600000) req/ms × 60000 ms × 0.6 = 36 requests/cycle
```

That `36` is constant regardless of fleet size. Now hold demand at a simple
baseline — every active school needs exactly one Horizon page this cycle (no
pending payments, no recent-activity boost, so priority reduces to the aging
term) — and see how many cycles it takes the aging mechanism to rotate through
the whole fleet at least once:

| Active schools | Demand vs. 36-token budget | Schools polled cycle 1 | Cycles to rotate through all schools once | Approx. worst-case staleness (`(cycles − 1) × 60s`) |
|---:|---|---:|---:|---:|
| 20 | 20 ≤ 36 — fits entirely | 20 | 1 | 0s (never deferred) |
| 50 | 50 > 36 — 14 deferred | 36 | 2 | ~60s |
| 100 | 100 > 36 | 36 | 3 | ~120s |
| 200 | 200 > 36 | 36 | 6 | ~300s (5 min) |
| 500 | 500 > 36 | 36 | 14 | ~780s (13 min) |

This is a simplified illustration, not the empirical SLA — it assumes uniform
one-page demand and ignores the pending-payment and recent-activity priority
boosts that, in practice, poll the schools operators actually care about first.
For the fuller, load-model-derived numbers (which do include those signals),
see the [Measured behaviour and the SLA](#measured-behaviour-and-the-sla)
section above. The point of this table is narrower: it shows *why* deferral and
staleness — not 429s — are the first symptom of an undersized budget, and why
the fix is one of the four levers in
[Operational guidance](#operational-guidance) below rather than raising
`SYNC_MAX_PAGES_PER_POLL` (which only bounds a single school's per-cycle
share, not the fleet-wide total).

## Observability

| Metric | Type | Use |
|---|---|---|
| `horizon_poll_budget_remaining` | gauge | Tokens left in the current cycle |
| `horizon_poll_budget_ceiling` | gauge | AIMD-adjusted ceiling; sustained drop means the configured limit is too high |
| `horizon_poll_deferred_schools` | gauge | Schools currently deferred |
| `horizon_poll_max_deferral_cycles` | gauge | **The SLA term.** Worst staleness in cycles |
| `horizon_poll_requests_total` | counter | Poller request volume |
| `horizon_rate_limited_total` | counter | Observed 429s; should be ~0 in steady state |

Suggested alerts:

- `horizon_poll_max_deferral_cycles > 5` for 15m — some tenant is falling behind
  the SLA.
- `rate(horizon_rate_limited_total[15m]) > 0` sustained — the configured limit
  exceeds the real one, or replica count is misconfigured.
- `horizon_poll_budget_ceiling < 0.5 × nominal` sustained — AIMD has pulled the
  ceiling well below configuration; investigate before adding tenants.

## Operational guidance

When `horizon_poll_deferred_schools` is persistently non-zero, the fleet has
outgrown its Horizon allowance. In rough order of preference:

1. Raise `HORIZON_RATE_LIMIT_PER_HOUR` if the real allowance is higher than the
   3600 default (paid or self-hosted Horizon).
2. Run a dedicated Horizon instance — removes the shared-limit problem outright.
3. Increase the poll interval. Counter-intuitive, but a longer interval yields a
   proportionally larger per-cycle budget and lets more schools be fully drained
   per cycle; if the fleet is budget-bound, the deferral queue shrinks.
4. Shard schools across replicas by `schoolId`, with `HORIZON_POLL_REPLICA_COUNT`
   set correctly.

## Related

- `backend/src/services/horizonPollBudget.js` — implementation and rationale
- `backend/src/services/transactionPollingService.js` — the poll loop
- `backend/src/services/stellarRateLimitedClient.js` — per-call throttling for
  non-poll Horizon traffic (Bottleneck, optionally Redis-backed)
- `tests/loadsim/horizonPollLoadModel.js` — the load model
