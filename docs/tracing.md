# Distributed tracing (OpenTelemetry)

> Closes #1636

Metrics answer "is something slow?"; logs with correlation IDs answer "what
happened to this payment?". Traces answer "**where** did the time go and
**which** retry / failover path was taken?" across HTTP, Horizon, MongoDB,
Redis, BullMQ (possibly on another replica), the outbox and webhook delivery.

Tracing is **off by default** and costs nothing when disabled — every helper in
`backend/src/tracing/index.js` is a no-op.

## Enabling

The OpenTelemetry SDK is an optional, opt-in install (it is not in the default
dependency set). In the backend image or checkout:

```bash
cd backend
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

Then set:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_TRACING_ENABLED` | `false` | Master switch. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP collector (Jaeger, Tempo, OTel Collector). |
| `OTEL_SERVICE_NAME` | `stellaredupay-backend` | `service.name` resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attributes; `service.version` (from `/api/version`) and `deployment.environment` are added automatically. |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on` | Standard OTel sampling, e.g. `parentbased_traceidratio` + `0.1` in production. |

If `OTEL_TRACING_ENABLED=true` but the SDK packages are missing, the backend
logs `[Tracing] … could not be loaded — tracing disabled` and keeps running.

### Local Jaeger

```bash
docker compose -f docker-compose.monitoring.yml up -d jaeger
OTEL_TRACING_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
```

Open <http://localhost:16686> and pick `stellaredupay-backend`. Grafana is also
provisioned with a Jaeger datasource. In production point the exporter at
Tempo or an OTel Collector instead.

## What a payment-verification trace contains

```
POST /api/payments/verify                     (http/express auto-instrumentation)
├─ mongodb / mongoose spans                   (idempotency store, payment writes)
├─ ioredis spans                              (rate-limit, idempotency, BullMQ add)
├─ stellar.<label>                            (withStellarRetry: attempts, retry events, tx hash)
│  └─ horizon.call                            (horizonFailoverClient: endpoint, index, failover)
└─ … job enqueued with traceContext …
queue.process verify-transaction              (BullMQ worker — same trace, any replica)
├─ stellar.* / horizon.call
├─ mongodb transaction spans
outbox.dispatch <event type>                  (outbox record carries traceContext)
└─ POST https://receiver/webhook              (http client span; `traceparent` sent to receiver)
```

### Propagation points

| Hop | Mechanism |
|-----|-----------|
| HTTP in / out (incl. axios, webhooks) | auto-instrumentation, W3C `traceparent` |
| BullMQ `verify-transaction` jobs | `job.data.traceContext`, injected in `queue/transactionQueue.js`, extracted in `services/transactionQueueService.js` |
| Outbox events | `traceContext` field captured by a `pre('validate')` hook in `models/outboxModel.js`, extracted in `services/outboxDispatcher.js` |
| Horizon | explicit spans in `horizonFailoverClient.call()` and `withStellarRetry()` |

Jobs recovered from MongoDB after a restart (`recoverPendingJobs`) start a new
trace, since the original request is long gone.

## Logs ↔ traces

When tracing is active every structured log line gains `trace_id` and
`span_id`, and the HTTP server span is tagged with `correlation.id` and
`request.id` (the queue span with `correlation.id` too). So you can:

- jump from a log line to its trace by `trace_id`, or
- find a trace from a correlation ID a client or webhook receiver reports
  (`X-Correlation-ID`) by searching the tag `correlation.id=<id>`.

Health probes and `/metrics` scrapes are not traced.

## Frontend

Not instrumented yet. Next.js supports server-side spans via an
`instrumentation.js` file; adding it is a follow-up and would use the same
`OTEL_*` variables.
