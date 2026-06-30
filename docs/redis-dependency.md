# Redis Dependency & Graceful Degradation

> Audit reference: Issue #83 (#872) — Redis is a single point of failure for the
> queue, SSE pub/sub, rate limiting, refresh tokens, and distributed locks.

When `REDIS_HOST` is set, Redis backs several subsystems at once, so a single
Redis outage has a wide blast radius. This document is the dependency surface,
the per-consumer degradation contract, the reconnection policy, and the HA
recommendation.

## Dependency surface

| Consumer            | Module                              | Used for                                  |
|---------------------|-------------------------------------|-------------------------------------------|
| Retry queue (BullMQ)| `queue/transactionRetryQueue.js`    | Durable failed-transaction retries        |
| SSE pub/sub         | `services/sseService.js`            | Cross-replica real-time event fan-out     |
| Rate limiting       | `middleware/rateLimiter.js`         | Shared rate-limit counters across replicas|
| Refresh-token store | auth/session layer                  | Refresh-token validity / revocation       |
| Distributed locks   | `services/distributedLock.js`       | Single-processing of a school's sync      |

## Degradation modes

Each consumer has a defined behaviour when Redis is unavailable:

| Consumer          | Degradation mode                                                                 |
|-------------------|---------------------------------------------------------------------------------|
| Distributed locks | **Fail closed** — `acquire()` returns `null` on Redis error, so the cycle is skipped rather than risking two workers proceeding. The unique index on `Payment {schoolId, txHash}` remains the authoritative dedup guard. |
| SSE pub/sub       | **Falls back to local fan-out** — a failed `PUBLISH` still delivers to clients connected to the current replica; cross-replica delivery is lost until Redis recovers. With `REDIS_HOST` unset it runs single-process by design. |
| Retry queue       | Initialization failure is surfaced loudly in logs and via `/health` (`retryQueue.status: failed`); the HTTP server still boots. Without `REDIS_HOST` the MongoDB backend is used (single-replica only — see [retry-backends.md](./retry-backends.md)). |
| Rate limiting     | Counters become in-process per replica (not shared); limits still apply locally. A loud startup warning is emitted for the MongoDB/in-process path. |
| Refresh tokens    | Validation degrades; treat as fail-closed for session issuance.                 |

The guiding principle: **anything guarding correctness (locks, dedup) fails
closed; anything best-effort (SSE) degrades to local.**

## Health reporting

`GET /health` reports Redis status under `checks.retryQueue`:

```json
"retryQueue": {
  "status": "ok",
  "backend": "bullmq",
  "redisConfigured": true,
  "redisStatus": "ready",
  "redisHost": "...",
  "lastUpdatedAt": "..."
}
```

`redisStatus` is one of `ready | connecting | reconnecting | unavailable |
closed | ended | disabled`. When Redis is configured but not `ready`, overall
health is reported as `degraded` (HTTP 200) — DB is still up and cached data can
be served.

## Reconnection policy

All consumers share one policy via `getRedisConnectionOptions()` in
`config/redisClient.js`, so backoff and transient-error handling are identical
everywhere (previously each client set its own ad-hoc options):

| Env var                          | Default | Meaning                              |
|----------------------------------|---------|--------------------------------------|
| `REDIS_RECONNECT_MAX_ATTEMPTS`   | `8`     | Reconnect attempts before giving up  |
| `REDIS_RECONNECT_BASE_DELAY_MS`  | `500`   | Base backoff between attempts        |
| `REDIS_RECONNECT_MAX_DELAY_MS`   | `30000` | Backoff cap                          |
| `REDIS_LOG_THROTTLE_MS`          | `60000` | Throttle for repeated Redis warnings |

- `retryStrategy` backs off exponentially and returns `null` after the max
  attempts (stop reconnecting).
- `reconnectOnError` reconnects only on transient codes (`ECONNREFUSED`,
  `ENOTFOUND`, `ETIMEDOUT`, `EHOSTUNREACH`).
- Consumers needing blocking commands (BullMQ Worker/QueueEvents, pub/sub
  subscriber, lock client) override `maxRetriesPerRequest: null` while inheriting
  the rest of the shared policy.

Pinned by `backend/tests/redisReconnectionPolicy.test.js`.

## High availability

For production, run Redis in an HA topology so a single node failure does not
take down all of the above simultaneously:

- **Redis Sentinel** — automatic failover for a primary/replica set. ioredis
  accepts `{ sentinels, name }`; thread these through `getRedisConnectionOptions`.
- **Redis Cluster** — sharded + replicated for horizontal scale.

Operationally: deploy Redis with persistence (AOF), monitor `redisStatus` via
`/health`, and alert on `degraded`. Pair HA Redis with `REPLICA_COUNT` set
correctly so the BullMQ backend is selected (never the in-process MongoDB
fallback) in multi-replica deployments.
