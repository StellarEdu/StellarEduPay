'use strict';

/**
 * Distributed tracing (OpenTelemetry) — #1636.
 *
 * OFF BY DEFAULT. Set OTEL_TRACING_ENABLED=true to turn it on. The OTel SDK
 * packages are regular backend dependencies (#1929), loaded lazily so that
 * tracing costs nothing when disabled. If they fail to load, development logs
 * a warning and runs without tracing; production (NODE_ENV=production) refuses
 * to start, so a misconfigured deployment is noticed immediately.
 *
 * Span exports are scrubbed: query strings are removed from URL attributes and
 * secret-looking parameters (token, password, ...) are masked in every string
 * attribute before the exporter sees them.
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
 * Attribute keys that carry a full URL or query string. Query strings are
 * dropped entirely: parent-portal and password-reset tokens travel in them.
 */
const URL_ATTRIBUTE_KEYS = new Set(['http.url', 'url.full', 'http.target']);

/**
 * Secret-looking query/form parameters. Anything matching is masked in every
 * string attribute and span name, whatever instrumentation produced it.
 */
const SECRET_PARAM_RE = /((?:^|[?&;\s"'])(?:access_token|refresh_token|reset_token|token|password|secret|api[_-]?key|code)=)[^&;\s"'#]*/gi;

function redactString(value) {
  return value.replace(SECRET_PARAM_RE, '$1[REDACTED]');
}

const QUERY_ONLY_ATTRIBUTE_KEYS = new Set(['url.query', 'http.query']);

function redactAttributeValue(key, value) {
  if (typeof value !== 'string') return value;
  if (QUERY_ONLY_ATTRIBUTE_KEYS.has(key)) return value ? '[REDACTED]' : value;
  if (URL_ATTRIBUTE_KEYS.has(key)) {
    const cut = value.indexOf('?');
    if (cut !== -1) return `${value.slice(0, cut)}?[REDACTED]`;
  }
  return redactString(value);
}

/**
 * Wraps the real exporter so that every span is scrubbed before it leaves the
 * process. Done at export time so it covers all instrumentations, not just
 * http.
 */
class RedactingSpanExporter {
  constructor(inner) {
    this.inner = inner;
  }

  export(spans, resultCallback) {
    for (const span of spans) {
      if (typeof span.name === 'string') span.name = redactString(span.name);
      if (span.attributes) {
        for (const key of Object.keys(span.attributes)) {
          span.attributes[key] = redactAttributeValue(key, span.attributes[key]);
        }
      }
    }
    return this.inner.export(spans, resultCallback);
  }

  forceFlush() {
    return typeof this.inner.forceFlush === 'function' ? this.inner.forceFlush() : Promise.resolve();
  }

  shutdown() {
    return this.inner.shutdown();
  }
}

/**
 * Start the OTel SDK. Must run before express, mongoose, ioredis etc. are
 * required so auto-instrumentation can patch them — app.js calls it first.
 *
 * In production (NODE_ENV=production) a missing SDK is a startup error rather
 * than a silent downgrade, so operators who asked for tracing notice at once.
 *
 * @param {object} [options]
 * @param {object} [options.traceExporter] exporter override (tests use an
 *   in-memory exporter); defaults to OTLP over HTTP.
 * @returns {boolean} whether tracing is active
 */
function initTracing(options = {}) {
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

    const innerExporter = options.traceExporter || new OTLPTraceExporter();

    sdk = new NodeSDK({
      traceExporter: new RedactingSpanExporter(innerExporter),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs and dns spans are noise for this service.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
          // Metrics scrapes are high-frequency noise. Health probes are traced
          // (see #1929 acceptance criteria).
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (req) => /^\/metrics(?:[/?]|$)/.test(req.url || ''),
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
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`[Tracing] OTEL_TRACING_ENABLED=true but the OpenTelemetry SDK could not be loaded: ${err.message}`);
    }
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
  redactString,
  shutdownTracing,
  isEnabled,
  withSpan,
  injectTraceContext,
  withExtractedContext,
  setActiveAttributes,
  currentTraceIds,
};
