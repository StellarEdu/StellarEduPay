# Transaction Retry Backends

> Audit reference: Issue #81 (#870) — single retry contract + guarantee matrix;
> Issue #82 (#871) — BullMQ worker configuration, dead-letter strategy, metrics.

Failed Stellar transaction verifications are retried by one of two backends,
selected at startup by `retryServiceSelector`:

- **BullMQ** (Redis-backed) — used when `REDIS_HOST` is set.
- **MongoDB** (`retryService`) — fallback when `REDIS_HOST` is unset.

Only one runs at a time. **Redis/BullMQ is required for any multi-replica
deployment** (see the guarantee matrix). On startup with the MongoDB backend and
`REPLICA_COUNT > 1` (also read from `WEB_CONCURRENCY` / `INSTANCE_COUNT` /
`NUMBER_OF_REPLICAS`), the selector logs a loud `[CRITICAL]` warning.

## Shared contract

Both backends classify failures through one shared module —
`backend/src/services/retryContract.js` — so a transaction that is retryable in
dev (Mongo) is retryable in prod (Redis) and vice versa.

- `PERMANENT_ERROR_CODES` → never retried; routed to the dead-letter backlog.
- `TRANSIENT_ERROR_CODES` + transient message patterns → retried with backoff.
- Everything else → `unknown` (retried until max attempts, then dead-lettered).

`backend/tests/retryBackendContract.test.js` runs the **same** classification
cases against both backends and asserts they agree on every case.

## Guarantee matrix

| Property            | BullMQ (Redis)                                  | MongoDB (`retryService`)                          |
|---------------------|-------------------------------------------------|---------------------------------------------------|
| Durability          | Jobs persisted in Redis; survive restarts       | Records persisted in MongoDB; survive restarts    |
| Multi-replica safe  | **Yes** — Redis coordinates a single consumer   | **No** — each replica polls independently         |
| Rate-limit scope    | Shared across replicas (Redis)                  | **In-process only** — per replica, resets on restart |
| Concurrency control | Explicit worker `concurrency` (`QUEUE_CONCURRENCY`) | Single in-process timer loop, batch of 50       |
| Ordering            | Not guaranteed (delayed/backoff jobs reorder)   | Roughly `nextRetryAt` order within a batch        |
| Backoff             | Exponential + jitter                            | Exponential (1m·2ⁿ, capped 60m), no jitter        |
| Dead-letter         | Dedicated `transaction-dead-letter-queue`       | `status: 'dead_letter'` on the PendingVerification |
| Stalled-job recovery| Yes (BullMQ lock + `maxStalledCount`)           | N/A (synchronous batch)                           |

The single-replica MongoDB path is correct and convenient for development; it is
**not** safe to run more than one replica against it.

## BullMQ worker configuration (Issue #82)

All options are explicit in `backend/src/queue/transactionRetryQueue.js` and
env-overridable:

| Env var                       | Default   | Meaning                                              |
|-------------------------------|-----------|-----------------------------------------------------|
| `QUEUE_CONCURRENCY`           | `5`       | Concurrent jobs per worker                           |
| `MAX_RETRY_ATTEMPTS`          | `10`      | Attempts before a job is dead-lettered               |
| `INITIAL_RETRY_DELAY_MS`      | `60000`   | Base backoff delay                                   |
| `MAX_RETRY_DELAY_MS`          | `3600000` | Backoff cap                                          |
| `RETRY_BACKOFF_MULTIPLIER`    | `2`       | Exponential multiplier                               |
| `RETRY_JITTER_RATIO`          | `0.2`     | ± jitter applied to each backoff delay               |
| `QUEUE_LOCK_DURATION_MS`      | `30000`   | Job lock TTL; must exceed worst-case processing time |
| `QUEUE_STALLED_INTERVAL_MS`   | `30000`   | How often stalled jobs are scanned                   |
| `QUEUE_MAX_STALLED_COUNT`     | `2`       | Stalled recoveries before failing for good           |
| `DLQ_ENABLED`                 | `true`    | Enable the dead-letter queue                         |
| `DLQ_MAX_AGE_MS`              | `604800000` (7d) | Dead-letter retention                         |

**Jitter** spreads retries so a batch of jobs that failed together (e.g. a
Horizon outage) don't all retry on the same tick — a thundering-herd guard. Jobs
are enqueued with `backoff.type: 'custom'`; the worker resolves the delay via a
registered `backoffStrategy` that applies exponential backoff **with** jitter.

**Retention:** completed jobs are trimmed (age 1h / last 1000); failed jobs are
kept for analysis; dead-lettered jobs are retained for `DLQ_MAX_AGE_MS`.

### Dead-letter queue

Permanently-failed and max-attempt-exhausted jobs are moved to
`transaction-dead-letter-queue`, inspectable by admins via `/api/retry-queue`
(see `retryQueueRoutes`). The MongoDB backend exposes the equivalent backlog
(`status: dead_letter`) with list/inspect/re-drive helpers in `retryService`.

### Metrics

Exported on `/metrics` (Prometheus):

- `queue_depth{queue}` — actionable jobs (waiting + active + delayed).
- `queue_failed{queue}` — failed + dead-lettered jobs per queue.
- `pending_verification_backlog{status}` — MongoDB-backend backlog depth.

Alert on sustained growth of `queue_failed` or any `transaction-dead-letter`
accumulation.
