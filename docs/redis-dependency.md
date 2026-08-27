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
| **Webhook nonce store** | `services/webhookService.js`    | **Inbound delivery replay deduplication** |

## Degradation modes

Each consumer has a defined behaviour when Redis is unavailable:

| Consumer          | Degradation mode                                                                 |
|-------------------|---------------------------------------------------------------------------------|
| Distributed locks | **Fail closed** — `acquire()` returns `null` on Redis error, so the cycle is skipped rather than risking two workers proceeding. The unique index on `Payment {schoolId, txHash}` remains the authoritative dedup guard. In multi-replica deployments (`REPLICA_COUNT > 1`), the leader election service **refuses to start** if Redis is not configured. This prevents all replicas from thinking they are the leader and running all background jobs in parallel. |
| SSE pub/sub       | **Falls back to local fan-out with client notification** — a failed `PUBLISH` still delivers to clients connected to the current replica; cross-replica delivery is lost until Redis recovers. All locally-connected clients receive an explicit `sse.degraded` SSE event so the frontend can render a visible warning banner (Issue #1054). An `sse.recovered` event is broadcast on reconnection. With `REDIS_HOST` unset it runs single-process by design (no degraded signal is emitted). |
| Retry queue       | Initialization failure is surfaced loudly in logs and via `/health` (`retryQueue.status: failed`); the HTTP server still boots. Without `REDIS_HOST` the MongoDB backend is used (single-replica only — see [retry-backends.md](./retry-backends.md)). |
| Rate limiting     | Counters become in-process per replica (not shared); limits still apply locally. A loud startup warning is emitted for the MongoDB/in-process path. |
| Refresh tokens    | Validation degrades; treat as fail-closed for session issuance.                 |
| **Webhook nonce store** | **Fail closed** — when Redis is unavailable (not configured, not ready, or returns an error during a nonce write), `_isReplay()` returns `true` so the delivery is **rejected** rather than allowed through with no dedup guarantee. This prevents a Redis outage from silently degrading replay protection from "cluster-wide" to "per-replica" in multi-replica deployments (`deploy/k8s/backend-deployment.yaml` sets `replicas: 2`). A warning is logged on every rejection: `Redis unavailable in _isReplay — failing closed`. **Operational impact:** while Redis is down, all inbound webhook deliveries that pass HMAC verification will be rejected with a replay error. Senders should retry once Redis is healthy. To restore the previous in-process-fallback behaviour (single-process dev/test environments only), set `WEBHOOK_REPLAY_NONCES_LOCAL=true`. |

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

## Leader Election & Multi-Replica Safety

When `REPLICA_COUNT > 1` and `REDIS_HOST` is not configured, the leader election
service (issue #1321) will **refuse to start** with a critical error. This is a hard
requirement because without distributed locks in a multi-replica deployment:

- All replicas believe they are the leader and run all background jobs N times per cycle.
- Reminders are sent N times to each parent.
- Audit logs record the same events N times, breaking the audit trail for compliance.
- Reconciliation runs in parallel, causing race conditions and incorrect balances.
- All other leader-only schedulers (webhook retry, metrics rollup, consistency checks) duplicate.

This is an unrecoverable configuration error in production. To proceed:

1. Set `REDIS_HOST` to a running Redis instance.
2. Ensure `REPLICA_COUNT` accurately reflects the number of deployed backend replicas.
3. Restart the application.

In development and test environments where `REPLICA_COUNT=1` or is unset, the in-process
lock fallback is safe and Redis is optional.
