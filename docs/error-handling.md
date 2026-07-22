# Error Handling Policy

## Process-level handlers

Installed in `src/errorHandling.js` and wired once from `src/app.js`.

### `unhandledRejection`
- **Action**: log structured context, then **exit(1)**.
- Rationale: an unhandled rejection is a programming error or failed async operation with no recovery path. Continuing risks data corruption and inconsistent state.

### `uncaughtException`
- **Action**: log structured context, then **exit(1)** immediately.
- Rationale: after an uncaught exception the process is in an untrusted state; continuing can produce silent data corruption.

## Promise rejection rules

- **Never use** `.catch(() => {})` — silent swallowing hides real failures.
- **Non-critical fire-and-forget** (e.g. auth sidecart writes, cleanup on shutdown): use `.catch(err => logger.debug(...))` so failures are observable via logs but do not crash the request flow.
- **Critical operations** (DB writes, payment records, token store): surface via Express error handlers or structured `logger.error(...)`; do not suppress.

## Crash vs. continue decision tree

| Situation | Action |
|---|---|
| Unhandled promise rejection anywhere in process | Log + exit(1) |
| Uncaught exception anywhere in process | Log + exit(1) |
| Fire-and-forget cleanup (Redis release, session update) | Log debug, continue |
| Request handler rejects | Pass to `next(err)` → global error handler |

## Graceful shutdown

`SIGTERM` / `SIGINT` trigger the existing `shutdown()` flow in `src/app.js` (drain workers, close queues, disconnect Mongo, then `process.exit(0)`).

## Multi-tenant blast radius

This is a single-process application serving many schools' traffic concurrently. The
crash-on-unhandled-rejection policy above is a defensible trade-off in isolation
(favoring data-safety over availability), but it means a bug in code handling one
tenant's data can `exit(1)` the whole process, dropping every other tenant's in-flight
requests too. Two concrete mitigations are in place:

1. **Reduce how often the crash trigger fires** — per-request/per-job error boundaries
   should catch and convert recoverable errors into HTTP responses or logged failures
   *before* they can become unhandled rejections, so the crash policy is a last resort
   rather than the primary safety net. Two boundary defects were found and fixed as a
   direct result of this review:
   - `src/middleware/idempotency.js` — the 5xx release-failure path
     (`idempotencyStore.release(canonicalKey).catch(...)`) referenced an out-of-scope
     `logger` variable, so a `release()` failure threw a `ReferenceError` *inside* the
     `.catch()` handler itself — an unhandled rejection with no further catch, on every
     school's failed-request path, not just the one that happened to fail. Fixed by
     hoisting a single module-level `logger`.
   - `src/services/outboxDispatcher.js` — `dispatchOutboxEvents` was passed directly to
     `setInterval`. It happens to catch everything it currently awaits internally, but
     nothing enforced that; a future edit adding an await outside its `try`/`catch`
     would silently start crashing the process on a schedule. Now wrapped with a
     terminal `.catch()` at the `setInterval` boundary so this class of bug is
     structurally impossible regardless of the function's internals.
2. **Reduce the blast radius when the trigger does fire anyway** — see "Recovery Time &
   Blast Radius" and "Known Limitations" below.

## Recovery Time & Blast Radius

What happens after a `process.exit(1)` depends entirely on the deployment topology.
Both topologies checked into this repo are analyzed below; app-boot time is a real,
locally measured figure, not an estimate.

**Measured app boot time** (cold `require` of the full dependency graph through
`app.listen()`; `NODE_ENV=production`, no reachable MongoDB — i.e. the JS-side floor,
excluding a live DB round trip): 3 runs on a dev machine — 6.72s / 6.19s / 7.22s
(avg ≈ 6.7s). Production containers won't redo `npm install` on restart, but the
`require` graph (~190+ modules) and Mongoose schema registration are the same cost
paid on every process start. This is the dominant, controllable component of recovery
time — orchestration-level restart *detection* (below) is comparatively fast and out of
this codebase's control.

### Kubernetes (`deploy/k8s/backend-deployment.yaml`) — `replicas: 2`

- Pod `restartPolicy` defaults to `Always`; kubelet detects the exited container and
  restarts it in the same pod, typically within a second or two (standard kubelet
  behavior, not independently re-measured here — no cluster available in this
  environment).
- `readinessProbe`: `initialDelaySeconds: 30`, `periodSeconds: 10`, `failureThreshold: 3`.
  Since measured boot (~7s) is well inside the 30s initial delay, the restarted pod
  passes its *first* readiness check and rejoins the Service's endpoint pool at
  **~30s** post-restart in the common case (worst case, if boot were slow:
  30s + 3×10s = 60s).
- **Blast radius**: the *other* replica keeps serving 100% of traffic for every
  unaffected school throughout that ~30s window (standard Kubernetes Service
  behavior — it routes only to ready endpoints). Only requests in flight on, or newly
  routed to, the specific crashing pod are dropped. This directly narrows — but does
  not eliminate — the "every tenant simultaneously" framing: with 2 replicas the
  practical blast radius is bounded to roughly the traffic share of one pod for ~30s,
  not a full outage.
- Running with `replicas: 1` (or any single-instance topology) removes this mitigation
  entirely — see below.

### Docker Compose (`docker-compose.yml`) — single instance

- The `backend` (and `frontend`, `mongo`) services previously had **no `restart`
  policy** (only `redis` did) — a crash was a permanent outage requiring manual
  `docker compose up`. Fixed: all now set `restart: unless-stopped`, so Docker restarts
  the exited container automatically, near-immediately absent a crash-loop.
- `healthcheck`: `start_period: 30s`, `interval: 10s`, `retries: 5`. Same as the k8s
  case, measured boot (~7s) fits inside `start_period`, so the container is marked
  healthy at the first check, **~30s** post-restart; dependents using
  `depends_on: condition: service_healthy` (i.e. `frontend`) wait for that.
- **Blast radius**: there is only one backend instance in this topology, so **every**
  tenant is fully down for the ~30–40s crash-to-healthy window. This is the scenario
  the "every tenant simultaneously" concern describes, and it is real specifically for
  single-instance deployments. Docker Compose here is a local/dev topology; production
  should run the Kubernetes manifest (or an equivalent ≥2-replica setup) precisely
  because of this gap.

## Known Limitations & Tracked Follow-ups

- **Tenant-isolation blast-radius reduction is not implemented — tracked here as a
  deliberate gap, not an oversight.** The crash-on-unhandled-rejection policy is only
  as safe as the replica count behind it (see above). Candidate approaches, roughly in
  increasing order of effort, for a future iteration:
  1. Treat replica count as the primary lever today: never run this service with
     `replicas: 1` in production: the k8s manifest already defaults to 2; keep it that
     way and monitor it as the trade-off requires.
  2. Partition tenants across independent process groups (e.g. consistent-hash
     `schoolId` → worker pool), so a crash triggered by one school's data only takes
     down the schools sharded onto that pool, not the whole fleet.
  3. Per-request isolation (e.g. worker threads or a stricter domain/async-context
     boundary per tenant) so a single request's fatal error can be contained without
     `process.exit` at all. Significant architectural change; not undertaken here.
  4. Continue auditing fire-and-forget `.catch(...)` handlers for the exact class of
     bug found in `idempotency.js` (a catch handler that can itself throw) — this is
     cheap, high-value, and should be a standing code-review checklist item rather than
     a one-time fix.
- This list is intentionally not actioned beyond item 1 in this change; it exists so
  the trade-off is an explicit, revisitable decision rather than an implicit one.
