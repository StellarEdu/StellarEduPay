'use strict';

/**
 * API Request Logging Middleware
 *
 * Logs every incoming request as a structured JSON line using the shared logger.
 * Captured fields:
 *   requestId  — unique ID per request (for correlation across log lines)
 *   method     — HTTP verb
 *   url        — full path + query string
 *   ip         — client IP (respects X-Forwarded-For when behind a proxy)
 *   statusCode — HTTP response status (logged on finish)
 *   durationMs — total response time in milliseconds
 *   userAgent  — caller's User-Agent header
 *   timestamp  — ISO-8601 (added by the logger itself)
 *
 * Logs are emitted as JSON to stdout, making them grep/jq-friendly and
 * compatible with any log aggregator (ELK, Datadog, CloudWatch, etc.).
 */

const { logger } = require('../utils/logger');
const { httpRequestDurationSeconds } = require('../metrics');
const { generateCorrelationId } = require('../utils/correlationId');
const { REQUEST_LOG_REDACT_FIELDS } = require('../utils/redactConfig');

const DEFAULT_REDACT_FIELDS = REQUEST_LOG_REDACT_FIELDS;

// Headers that must never appear in logs (auth/session/PII)
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'idempotency-key',
]);

function getRedactFields() {
  if (process.env.LOG_REDACT_FIELDS) {
    return process.env.LOG_REDACT_FIELDS.split(',').map((f) => f.trim()).filter(Boolean);
  }
  return DEFAULT_REDACT_FIELDS;
}

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const fields = getRedactFields();
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (fields.includes(key)) {
      result[key] = '[REDACTED]';
    }
  }
  return result;
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

let _counter = 0;

function generateRequestId() {
  _counter = (_counter + 1) % 1_000_000;
  return `${Date.now()}-${process.pid}-${String(_counter).padStart(6, '0')}`;
}

function requestLogger() {
  return (req, res, next) => {
    const requestId = generateRequestId();
    const correlationId = generateCorrelationId();
    const startedAt = Date.now();

    // Attach to req so downstream handlers can reference it (e.g. error logs)
    req.requestId = requestId;
    req.correlationId = correlationId;

    // Propagate correlation ID to the response so callers can trace end-to-end
    res.setHeader('X-Correlation-ID', correlationId);

    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    const logData = {
      requestId,
      correlationId,
      method: req.method,
      url: req.originalUrl,
      ip,
      userAgent: req.headers['user-agent'] || '',
    };

    if (req.body && Object.keys(req.body).length > 0) {
      logData.body = redact(req.body);
    }
    if (req.query && Object.keys(req.query).length > 0) {
      logData.query = redact(req.query);
    }
    if (process.env.LOG_REQUEST_HEADERS === 'true') {
      logData.headers = redactHeaders(req.headers);
    }

    logger.info('[Request] incoming', logData);

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      logger[level]('[Request] completed', {
        requestId,
        correlationId,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
        ip,
      });

      // Normalise to the matched route pattern (e.g. /api/payments/:id) so high-cardinality
      // path parameters don't explode the label set. Falls back to the raw path on 404s.
      const route = req.route ? req.baseUrl + req.route.path : req.path;
      httpRequestDurationSeconds.observe(
        { method: req.method, route, status: String(res.statusCode) },
        durationMs / 1000
      );
    });

    next();
  };
}

module.exports = { requestLogger, redact, redactHeaders };
