# Load Simulation

`tests/loadsim/horizonPollLoadModel.js` is a discrete-event model of Horizon
polling under rate-limit pressure. It exists because the claim behind the
coordinated polling budget (#1124) is a claim about behaviour at a school count
we cannot provision in CI, against a rate limit we do not control.

## What runs it

`tests/loadsim/horizonPollLoadModel.test.js` drives the model and asserts the
mechanisms it depends on. Run it with:

```bash
npm run test:loadsim
```

The suite is excluded from the default `npm test` run via the
`tests/loadsim/` entry in `testPathIgnorePatterns`, so it does not add its
simulation cost to every CI run.

## When to run it

Run `npm run test:loadsim` when you change any of:

- `backend/src/services/horizonPollBudget.js` (budget sizing, priority
  ordering, deferral accounting)
- `backend/src/services/transactionPollingService.js`, specifically the
  `consecutiveErrors` / `POLL_MAX_BACKOFF_MS` cycle-level backoff
- the model itself

Outside those cases the default suite is enough.

## What the assertions cover

The tests assert properties, not tuned percentile numbers, so they fail when
the budget service stops behaving the way the model assumes rather than when a
delay figure drifts:

- the model is deterministic for a fixed seed, so any failure reproduces
- every simulated payment ends up counted as resolved or unresolved
- the scenario is genuinely oversubscribed, so uncoordinated polling does hit
  the allowance and waste requests
- coordinated polling never overshoots the allowance and never trips the
  cycle-level backoff
- coordinated polling has lower p95, p99 and maximum sync delay
- a roomy allowance rate-limits neither strategy, which guards against a model
  that manufactures rate limiting regardless of capacity

## Interpreting a failure

A failure here is not necessarily a regression in production behaviour: it can
equally mean the model has drifted from the implementation. Check which of the
two moved before changing either. If the budget service intentionally changed
shape, update the model in the same commit so the two stay in step.
