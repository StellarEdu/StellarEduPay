'use strict';

/**
 * Distributed tracing (OpenTelemetry) — #1636.
 *
 * OFF BY DEFAULT. Set OTEL_TRACING_ENABLED=true to turn it on. The OTel SDK
 * packages are optional: they are loaded lazily and are not part of the
 * default install, so an image built without them simply logs a warning and
 * runs with tracing disabled. To enable tracing in an image:
 *
 *   npm install @opentelemetry/api @opentelemetry/sdk-node \
 *     @opentelemetry/auto-instrumentations-node \
 *     @opentelemetry/exporter-trace-otlp-http
 *
 * Auto-instrumentation covers http/express (incoming requests and outgoing
 * axios calls, which also propagates W3C `traceparent` to webhook receivers),
 * mongodb/mongoose and ioredis. Context is propagated by hand where
 * auto-instrumentation cannot see it:
 *   - BullMQ jobs carry `traceContext` in job.data (queue/transactionQueue.js)
 *   - Outbox records carry `traceContext` (models/outboxModel.js)
 *   - Horizon calls get explicit spans (horizonFailoverClient, withStellarRetry)
 *
 * Every helper here is a cheap no-op when tracing is disabled, so call sites
 * never need to check isEnabled() themselves.
 *
 * Standard OTEL_* env vars are honoured by the SDK, notably
 * OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318),
 * OTEL_SERVICE_NAME (default stellaredupay-backend) and
 * OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG.
 *
 * This module deliberately does not require utils/logger (the logger reads
 * trace IDs from here) and logs through console instead.
 */

const NOOP_SPAN = Object.freeze({
  setAttribute() { return this; },
  setAttributes() { return this; },
  addEvent() { return this; },
  recordException() {},
  setStatus() { return this; },
  end() {},
  isRecording() { return false; },
  spanContext() { return { traceId: '', spanId: '' }; },
});

let api = null;
let sdk = null;
let enabled = false;

function isEnabled() {
  return enabled;
}

/**
 * Start the OTel SDK. Must run before express, mongoose, ioredis etc. are
 * required so auto-instrumentation can patch them — app.js calls it first.
 *
 * @returns {boolean} whether tracing is active
 */
function initTracing() {
  if (enabled) return true;
  if (process.env.OTEL_TRACING_ENABLED !== 'true') return false;

  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { getBuildInfo } = require('../utils/buildInfo');

    if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = 'stellaredupay-backend';
    const { version } = getBuildInfo();
    process.env.OTEL_RESOURCE_ATTRIBUTES = [
      process.env.OTEL_RESOURCE_ATTRIBUTES,
      `service.version=${version}`,
      `deployment.environment=${process.env.NODE_ENV || 'development'}`,
    ].filter(Boolean).join(',');

    sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs and dns spans are noise for this service.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
          // Never record health probes / metrics scrapes as traces.
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (req) => /^\/(health|metrics)/.test(req.url || ''),
          },
        }),
      ],
    });
    sdk.start();
    api = require('@opentelemetry/api');
    enabled = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: '[Tracing] OpenTelemetry tracing enabled',
      args: [{ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318' }],
      pid: process.pid,
    }));
  } catch (err) {
    sdk = null;
    api = null;
    enabled = false;
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      message: '[Tracing] OTEL_TRACING_ENABLED=true but the OpenTelemetry SDK could not be loaded — tracing disabled',
      args: [{ error: err.message }],
      pid: process.pid,
    }));
  }
  return enabled;
}

/** Flush and stop the exporter during graceful shutdown. */
async function shutdownTracing() {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (_) {
    // exporter unreachable at shutdown — spans are best-effort
  } finally {
    sdk = null;
    enabled = false;
  }
}

function tracer() {
  return api.trace.getTracer('stellaredupay-backend');
}

/**
 * Run `fn(span)` inside a new active span. The span ends when `fn` settles;
 * a thrown error is recorded on it and re-thrown unchanged.
 *
 * @param {string} name
 * @param {object} [attributes]
 * @param {function(span): *} fn
 */
function withSpan(name, attributes, fn) {
  if (typeof attributes === 'function') {
    fn = attributes;
    attributes = {};
  }
  if (!enabled) return fn(NOOP_SPAN);

  return tracer().startActiveSpan(name, { attributes: cleanAttributes(attributes) }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: err && err.message });
      if (err && err.code) span.setAttribute('error.code', String(err.code));
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Drop undefined/null attribute values, which OTel rejects. */
function cleanAttributes(attributes = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined && v !== null) out[k] = typeof v === 'object' ? String(v) : v;
  }
  return out;
}

/**
 * Serialise the active context as W3C trace-context headers so it can ride
 * along in a BullMQ job or an outbox record.
 *
 * @returns {{traceparent?: string, tracestate?: string}|undefined}
 */
function injectTraceContext() {
  if (!enabled) return undefined;
  const carrier = {};
  api.propagation.inject(api.context.active(), carrier);
  return carrier.traceparent ? carrier : undefined;
}

/**
 * Run `fn` with the context described by `carrier` (from injectTraceContext)
 * as the parent, so spans started inside continue the original trace.
 */
function withExtractedContext(carrier, fn) {
  if (!enabled || !carrier || typeof carrier !== 'object') return fn();
  const ctx = api.propagation.extract(api.context.active(), carrier);
  return api.context.with(ctx, fn);
}

/** Add attributes to the currently active span, if any. */
function setActiveAttributes(attributes) {
  if (!enabled) return;
  const span = api.trace.getActiveSpan();
  if (span) span.setAttributes(cleanAttributes(attributes));
}

/**
 * IDs of the active span, used by the logger to link log lines (and the
 * correlation ID they carry) to the trace.
 *
 * @returns {{trace_id: string, span_id: string}|null}
 */
function currentTraceIds() {
  if (!enabled) return null;
  const span = api.trace.getActiveSpan();
  if (!span) return null;
  const { traceId, spanId } = span.spanContext();
  if (!traceId || /^0+$/.test(traceId)) return null;
  return { trace_id: traceId, span_id: spanId };
}

module.exports = {
  initTracing,
  shutdownTracing,
  isEnabled,
  withSpan,
  injectTraceContext,
  withExtractedContext,
  setActiveAttributes,
  currentTraceIds,
};
