'use strict';

const axios = require('axios');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const WebhookRetry = require('../models/webhookRetryModel');
const WebhookEndpoint = require('../models/webhookEndpointModel');
const WebhookDelivery = require('../models/webhookDeliveryModel');
const { validateWebhookUrl, validateResolvedIp } = require('../utils/validateWebhookUrl');
const { resolveDnsWithCache } = require('../utils/dnsCache');
const { buildWebhookPayload } = require('../utils/buildWebhookPayload');
const logger = require('../utils/logger').child('WebhookService');

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536; // 64 KB
const REPLAY_WINDOW_S = parseInt(process.env.WEBHOOK_REPLAY_WINDOW_S || '300', 10);
const WEBHOOK_MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '3', 10);

// ── Lease / stuck-recovery — Issue #74 ───────────────────────────────────────
//
// LEASE_TIMEOUT_MS: how long a 'processing' lease is considered valid. After
// this duration, processPendingRetries() resets the document to 'pending' so
// another worker can pick it up. Must be comfortably larger than
// WEBHOOK_TIMEOUT_MS to avoid false recovery while the HTTP call is in flight.
const LEASE_TIMEOUT_MS = parseInt(
  process.env.WEBHOOK_LEASE_TIMEOUT_MS || String(WEBHOOK_TIMEOUT_MS * 3),
  10,
);

// Stable worker identifier used as leasedBy. Helps ops trace which replica
// held a lease.
const WORKER_ID = `${os.hostname()}:${process.pid}`;

// ── In-process replay-protection nonce store ─────────────────────────────────
const _localNonces = new Map();

function _evictExpiredNonces() {
  const now = Date.now();
  for (const [id, exp] of _localNonces) {
    if (now > exp) _localNonces.delete(id);
  }
}

async function _isReplay(deliveryId) {
  const { getRedisClient, isRedisReady } = require('../config/redisClient');
  if (isRedisReady()) {
    const redis = getRedisClient();
    const key = `webhook:nonce:${deliveryId}`;
    try {
      const result = await redis.set(key, '1', 'EX', REPLAY_WINDOW_S, 'NX');
      return result === null;
    } catch (redisErr) {
      // Redis operation failed during an otherwise-ready connection (e.g. a
      // transient command error). Fail closed: treat as a replay rather than
      // silently allowing the delivery through with no dedup guarantee.
      logger.error('Redis error in _isReplay — failing closed', {
        deliveryId, error: redisErr.message,
      });
      return true;
    }
  }
  // Redis is not configured or not ready. In a multi-replica deployment the
  // per-process Map provides no cross-replica dedup guarantee. Fail closed so
  // integrators receive a clear operational signal (Redis required) rather than
  // silently degraded replay protection.
  //
  // If Redis is intentionally absent (single-process dev/test), set
  // WEBHOOK_REPLAY_NONCES_LOCAL=true to restore the previous in-process fallback.
  if (!process.env.WEBHOOK_REPLAY_NONCES_LOCAL) {
    logger.warn('Redis unavailable in _isReplay — failing closed (set WEBHOOK_REPLAY_NONCES_LOCAL=true to enable in-process fallback)', {
      deliveryId,
    });
    return true;
  }
  _evictExpiredNonces();
  if (_localNonces.has(deliveryId)) return true;
  _localNonces.set(deliveryId, Date.now() + REPLAY_WINDOW_S * 1000);
  return false;
}

function _resetNonces() { _localNonces.clear(); }

// ── HMAC helpers ─────────────────────────────────────────────────────────────

/**
 * V1 signature — signs only the JSON body (legacy, kept for backward compat).
 * @param {object} payload
 * @param {string} secret
 * @returns {string} hex digest
 */
function generateSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

/**
 * V2 signature — signs `${timestamp}.${deliveryId}.${rawBody}` where rawBody
 * is the exact serialised JSON string that is transmitted on the wire.
 *
 * This binds the timestamp and delivery-ID to the signature so an attacker
 * cannot replay a valid signature with a rewritten timestamp or a fresh
 * delivery-ID.
 *
 * @param {number|string} timestamp  Unix epoch seconds
 * @param {string}        deliveryId UUID of this delivery
 * @param {string}        rawBody    The exact JSON string sent in the HTTP body
 * @param {string}        secret     HMAC secret
 * @returns {string} hex digest
 */
function generateSignatureV2(timestamp, deliveryId, rawBody, secret) {
  const signingBase = `${timestamp}.${deliveryId}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signingBase).digest('hex');
}

function verifySignature(payload, providedSignature, secret) {
  const expected = generateSignature(payload, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf   = Buffer.from(providedSignature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Verify a V2 signature (constant-time comparison).
 *
 * @param {number|string} timestamp
 * @param {string}        deliveryId
 * @param {string}        rawBody    Exact bytes received
 * @param {string}        providedSignature  Hex digest (without 'sha256=' prefix)
 * @param {string}        secret
 * @returns {boolean}
 */
function verifySignatureV2(timestamp, deliveryId, rawBody, providedSignature, secret) {
  const expected = generateSignatureV2(timestamp, deliveryId, rawBody, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  let actualBuf;
  try {
    actualBuf = Buffer.from(providedSignature, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ── Backoff ──────────────────────────────────────────────────────────────────
function getBackoffDelay(attemptNumber) {
  const delays = [60_000, 300_000, 900_000]; // 1 min, 5 min, 15 min
  return delays[Math.min(attemptNumber, delays.length - 1)];
}

// ── DNS pinning: re-resolve at send time ──────────────────────────────────────
/**
 * Re-resolve the hostname at send time with TTL-aware caching and verify
 * every returned IP against the deny list (DNS-rebinding defence).
 *
 * Uses TTL-aware caching to detect DNS changes when TTL expires, ensuring
 * a post-registration DNS rebinding attack (where DNS record changes to point
 * to a private IP) is caught at delivery time.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function _validateAtSendTime(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'INVALID_URL' }; }

  const hostname = parsed.hostname;

  // Bare IP literals are already locked — re-check the deny list directly.
  const rawIPv6 = hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(hostname) || net.isIPv6(rawIPv6)) {
    const ip = net.isIPv6(rawIPv6) ? rawIPv6 : hostname;
    const check = validateResolvedIp(ip);
    return check.blocked ? { ok: false, reason: check.reason } : { ok: true };
  }

  // DNS re-resolution with TTL-aware caching (cache expires when TTL expires)
  let all;
  try {
    all = await resolveDnsWithCache(hostname);
  } catch {
    return { ok: false, reason: 'DNS_RESOLUTION_FAILED' };
  }

  for (const addr of all) {
    const check = validateResolvedIp(addr);
    if (check.blocked) return { ok: false, reason: check.reason };
  }
  return { ok: true };
}

// ── Axios instance with SSRF-safe defaults ────────────────────────────────────
/**
 * Build a per-request Axios instance.
 * - maxRedirects: 0 disables redirect following entirely.
 * - maxContentLength caps response body at 64 KB.
 * - timeout of 10 s matches WEBHOOK_TIMEOUT_MS.
 */
function _buildAxiosInstance() {
  return axios.create({
    timeout: WEBHOOK_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: Infinity,
  });
}

// ── Delivery log writer ───────────────────────────────────────────────────────
/**
 * Persist a WebhookDelivery record. Never throws — logging failures must not
 * break the primary delivery flow.
 */
async function _writeDeliveryLog({
  endpointId, schoolId, deliveryId, event, payload,
  statusCode, responseBody, success, attemptCount, durationMs, error,
}) {
  try {
    const truncated = responseBody
      ? String(responseBody).slice(0, 1024)
      : null;
    await WebhookDelivery.create({
      endpointId,
      schoolId,
      deliveryId,
      event,
      payload,
      statusCode: statusCode || null,
      responseBody: truncated,
      success,
      attemptCount,
      durationMs: durationMs || null,
      error: error || null,
      lastAttemptAt: new Date(),
    });
  } catch (err) {
    logger.error('Failed to write webhook delivery log', {
      deliveryId, endpointId, error: err.message,
    });
  }
}

// ── Core delivery function ────────────────────────────────────────────────────
/**
 * Fire a single webhook delivery to one URL.
 *
 * #866: re-validates the resolved IP at send time and disables redirects.
 * #867: accepts a filteredPayload that has already been PII-filtered by the
 *       caller via buildWebhookPayload().
 *
 * @param {object} opts
 * @param {string}  opts.url
 * @param {string}  opts.event
 * @param {object}  opts.filteredPayload   PII-filtered payload (from buildWebhookPayload)
 * @param {object}  opts.rawPayload        Original payload for retry queue storage
 * @param {string|null} opts.secret
 * @param {string}  opts.deliveryId
 * @param {string|null} opts.endpointId    ObjectId string of WebhookEndpoint (null for legacy)
 * @param {string|null} opts.schoolId
 * @param {number}  [opts.attemptCount=1]
 * @returns {Promise<{success: boolean, statusCode?: number, error?: string, deliveryId: string}>}
 */
async function _sendToUrl({
  url, event, filteredPayload, rawPayload, secret, deliveryId,
  endpointId = null, schoolId = null, attemptCount = 1,
}) {
  const correlationId = rawPayload?.correlationId || null;

  // #866: send-time DNS re-validation
  const sendCheck = await _validateAtSendTime(url);
  if (!sendCheck.ok) {
    logger.error('Webhook delivery blocked at send time (DNS rebinding check)', {
      url, deliveryId, reason: sendCheck.reason,
    });
    if (endpointId) {
      await _writeDeliveryLog({
        endpointId, schoolId, deliveryId, event, payload: filteredPayload,
        statusCode: null, responseBody: null, success: false,
        attemptCount, durationMs: 0, error: `SSRF_BLOCKED: ${sendCheck.reason}`,
      });
    }
    return { success: false, error: 'SSRF_BLOCKED', deliveryId };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const body = {
    event,
    timestamp: new Date(timestamp * 1000).toISOString(),
    data: filteredPayload,
  };

  // Serialize exactly once so the bytes we sign are the bytes we transmit.
  const rawBody = JSON.stringify(body);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'StellarEduPay-Webhook/1.0',
    'X-Webhook-Event': event,
    'X-StellarEduPay-Timestamp': String(timestamp),
    'X-StellarEduPay-Delivery-ID': deliveryId,
  };
  if (correlationId) headers['X-StellarEduPay-Correlation-Id'] = correlationId;
  if (secret) {
    // V1 — kept for backward compatibility during the migration window.
    // Signs JSON.stringify(body) only; timestamp and deliveryId are NOT covered.
    headers['X-StellarEduPay-Signature'] = `sha256=${generateSignature(body, secret)}`;
    // V2 — signs `timestamp.deliveryId.rawBody` so the timestamp and delivery-ID
    // are bound to the signature and cannot be rewritten by an attacker.
    headers['X-StellarEduPay-Signature-V2'] = `sha256=${generateSignatureV2(timestamp, deliveryId, rawBody, secret)}`;
  }

  // Generic tracing header (#978); the vendor-specific correlation + signature
  // headers are already set above.
  if (correlationId) headers['X-Correlation-ID'] = correlationId;

  const http = _buildAxiosInstance();
  const startTime = Date.now();

  try {
    const response = await http.post(url, rawBody, {
      headers,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const durationMs = Date.now() - startTime;
    logger.info('Webhook delivered successfully', {
      url, event, deliveryId, correlationId,
      statusCode: response.status, durationMs,
    });

    // #868: record success metric
    try {
      const { recordDeliverySuccess } = require('../metrics/webhookMetrics');
      recordDeliverySuccess(event, durationMs);
    } catch (_) {}

    if (endpointId) {
      const truncatedBody = typeof response.data === 'string'
        ? response.data.slice(0, 1024)
        : JSON.stringify(response.data || '').slice(0, 1024);
      await _writeDeliveryLog({
        endpointId, schoolId, deliveryId, event, payload: filteredPayload,
        statusCode: response.status, responseBody: truncatedBody,
        success: true, attemptCount, durationMs, error: null,
      });
    }

    return { success: true, statusCode: response.status, deliveryId };

  } catch (err) {
    const durationMs = Date.now() - startTime;

    // #866: treat 3xx as an SSRF_REDIRECT_BLOCKED failure (maxRedirects:0
    // causes axios to throw on any redirect response)
    let errorMessage;
    let statusCode = null;
    if (err.response) {
      statusCode = err.response.status;
      if (statusCode >= 300 && statusCode < 400) {
        errorMessage = `SSRF_REDIRECT_BLOCKED: ${statusCode} ${err.response.statusText}`;
        logger.warn('Webhook redirect blocked (SSRF defence)', {
          url, event, deliveryId, statusCode,
        });
      } else {
        errorMessage = `HTTP ${statusCode}: ${err.response.statusText}`;
      }
    } else if (err.code === 'ECONNABORTED') {
      errorMessage = 'Connection timeout';
    } else {
      errorMessage = err.message;
    }

    logger.error('Webhook delivery failed', {
      url, event, deliveryId, correlationId, error: errorMessage, durationMs,
    });

    // #868: record failure metric
    try {
      const { recordDeliveryFailure } = require('../metrics/webhookMetrics');
      recordDeliveryFailure(event, durationMs, false, schoolId);
    } catch (_) {}

    if (endpointId) {
      const truncatedBody = err.response?.data
        ? String(err.response.data).slice(0, 1024)
        : null;
      await _writeDeliveryLog({
        endpointId, schoolId, deliveryId, event, payload: filteredPayload,
        statusCode, responseBody: truncatedBody,
        success: false, attemptCount, durationMs, error: errorMessage,
      });
    }

    return { success: false, statusCode, error: errorMessage, deliveryId };
  }
}

// ── Multi-endpoint dispatcher ─────────────────────────────────────────────────
/**
 * Fire a webhook event to ALL active WebhookEndpoint documents that subscribe
 * to the given event for the given school.
 *
 * #865: per-endpoint subscriptions, delivery logging, disabled-endpoint skipping.
 * #866: send-time SSRF re-validation inside _sendToUrl.
 * #867: PII filtering via buildWebhookPayload per endpoint's school config.
 *
 * @param {string} schoolId
 * @param {string} event
 * @param {object} rawPayload      Full payload (may contain PII)
 * @param {string[]|null} allowedFields  From school.webhookPayloadConfig.allowedFields
 * @returns {Promise<Array<{endpointId, success, statusCode?, error?, deliveryId}>>}
 */
async function fireWebhookToEndpoints(schoolId, event, rawPayload, allowedFields = null) {
  // #867: build the PII-filtered payload once for all endpoints of this school
  const filteredPayload = buildWebhookPayload(rawPayload, allowedFields);

  // #865: query active endpoints subscribed to this event
  const endpoints = await WebhookEndpoint.find({
    schoolId,
    isActive: true,
    subscribedEvents: event,
  }).lean();

  if (endpoints.length === 0) return [];

  const results = [];
  for (const ep of endpoints) {
    const deliveryId = uuidv4();

    // Static URL validation (at registration we already validated, but verify
    // scheme/hostname sanity quickly before DNS re-resolve)
    const urlCheck = await validateWebhookUrl(ep.url);
    if (!urlCheck.valid) {
      logger.error('Webhook endpoint URL failed validation', {
        endpointId: ep._id, url: ep.url, reason: urlCheck.reason,
      });
      await _writeDeliveryLog({
        endpointId: ep._id, schoolId, deliveryId, event,
        payload: filteredPayload, statusCode: null, responseBody: null,
        success: false, attemptCount: 1, durationMs: 0,
        error: 'URL_VALIDATION_FAILED',
      });
      results.push({ endpointId: ep._id, success: false, error: 'URL_VALIDATION_FAILED', deliveryId });
      continue;
    }

    // Replay protection
    if (await _isReplay(deliveryId)) {
      logger.warn('Webhook replay detected', { deliveryId, event, endpointId: ep._id });
      results.push({ endpointId: ep._id, success: false, error: 'REPLAY_DETECTED', deliveryId });
      continue;
    }

    const result = await _sendToUrl({
      url: ep.url,
      event,
      filteredPayload,
      rawPayload,
      secret: ep.secret,
      deliveryId,
      endpointId: ep._id,
      schoolId,
      attemptCount: 1,
    });

    // Queue for retry on failure
    if (!result.success) {
      try {
        await queueWebhookRetry(ep.url, event, rawPayload, result.error, ep.secret, deliveryId, ep._id, schoolId);
      } catch (qErr) {
        logger.error('Failed to queue webhook retry', { endpointId: ep._id, error: qErr.message });
      }
    }

    results.push({ endpointId: ep._id, ...result });
  }

  return results;
}

/**
 * Legacy single-URL fireWebhook — used by the retry queue and direct callers
 * that still pass a URL+secret explicitly (e.g. paymentSavedSubscribers
 * legacy path, DLQ replay).
 *
 * #866: send-time re-validation is applied inside _sendToUrl.
 *
 * @param {string} url
 * @param {string} event
 * @param {object} payload
 * @param {string|null} secret
 * @param {string|null} deliveryId
 * @param {string|null} endpointId  ObjectId string if known (for delivery log)
 * @param {string|null} schoolId
 * @returns {Promise<{success, statusCode?, error?, queued?, deliveryId}>}
 */
async function fireWebhook(url, event, payload, secret = null, deliveryId = null, endpointId = null, schoolId = null) {
  const correlationId = payload?.correlationId || null;

  if (!url) return { success: false, error: 'No webhook URL configured', deliveryId: null };

  const urlCheck = await validateWebhookUrl(url);
  if (!urlCheck.valid) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', {
      url, correlationId, reason: urlCheck.reason,
    });
    return { success: false, error: 'Invalid or disallowed webhook URL', deliveryId: null };
  }

  const id = deliveryId || uuidv4();

  if (await _isReplay(id)) {
    logger.warn('Webhook replay detected', { deliveryId: id, event, url, correlationId });
    return { success: false, error: 'Replay detected: delivery already processed', deliveryId: id };
  }

  const result = await _sendToUrl({
    url, event,
    filteredPayload: payload,
    rawPayload: payload,
    secret, deliveryId: id,
    endpointId, schoolId, attemptCount: 1,
  });

  if (!result.success) {
    try {
      await queueWebhookRetry(url, event, payload, result.error, secret, id, endpointId, schoolId);
      return { ...result, queued: true };
    } catch (qErr) {
      logger.error('Failed to queue webhook retry', { url, event, error: qErr.message });
      return { ...result, queued: false };
    }
  }

  return result;
}

// ── Retry queue ───────────────────────────────────────────────────────────────
async function queueWebhookRetry(url, event, payload, error, secret = null, deliveryId = null, endpointId = null, schoolId = null) {
  const nextRetryAt = new Date(Date.now() + getBackoffDelay(0));
  const id = deliveryId || uuidv4();

  await WebhookRetry.create({
    url,
    event,
    payload,
    secret: secret || null,
    deliveryId: id,
    correlationId: payload?.correlationId || null,
    endpointId: endpointId || null,
    schoolId: schoolId || null,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    nextRetryAt,
    lastError: error,
    errorLog: [{ attemptNumber: 0, error, timestamp: new Date() }],
  });
}

/**
 * Recover stuck processing leases — Issue #74.
 *
 * Finds 'processing' documents whose leasedAt is older than LEASE_TIMEOUT_MS
 * and resets them to 'pending' so another worker can pick them up. Safe to run
 * concurrently across replicas — the findOneAndUpdate filter ensures only one
 * worker reclaims each stuck document.
 */
async function recoverStuckLeases() {
  const cutoff = new Date(Date.now() - LEASE_TIMEOUT_MS);
  let recovered = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const doc = await WebhookRetry.findOneAndUpdate(
      { status: 'processing', leasedAt: { $lt: cutoff } },
      { $set: { status: 'pending', leasedAt: null, leasedBy: null } },
      { new: true }
    );
    if (!doc) break;
    logger.warn('Recovered stuck webhook lease', {
      deliveryId: doc.deliveryId, url: doc.url, leasedBy: doc.leasedBy,
    });
    recovered++;
  }

  return recovered;
}

/**
 * Process pending webhook retries — Issue #74 (atomic claiming).
 *
 * Each pending+due retry is claimed atomically with findOneAndUpdate (flipping
 * status pending → processing) before sending. Only the worker that wins the
 * claim delivers it, so concurrent replicas never double-deliver. Stuck leases
 * from crashed workers are recovered before picking up new work.
 */
async function processPendingRetries() {
  try {
    // 1. Recover any stuck leases from crashed workers.
    const stuckRecovered = await recoverStuckLeases();
    if (stuckRecovered > 0) {
      logger.info('WEBHOOK_RETRY_STUCK_RECOVERED', { count: stuckRecovered });
    }

    // 2. Atomically claim and process up to 10 pending retries.
    const now = new Date();
    let processed = 0;

    for (let i = 0; i < 10; i++) {
      const claimed = await WebhookRetry.findOneAndUpdate(
        { status: 'pending', nextRetryAt: { $lte: now } },
        { $set: { status: 'processing', leasedAt: new Date(), leasedBy: WORKER_ID } },
        { new: true, sort: { nextRetryAt: 1 } } // oldest-due first
      );
      if (!claimed) break; // no more pending retries
      await retryWebhook(claimed);
      processed++;
    }

    return { processed };
  } catch (err) {
    logger.error('Error processing webhook retries', { error: err.message });
    throw err;
  }
}

async function retryWebhook(retry) {
  const correlationId = retry.correlationId || retry.payload?.correlationId || null;

  const urlCheck = await validateWebhookUrl(retry.url);
  if (!urlCheck.valid) {
    logger.error('Webhook retry blocked: URL failed SSRF validation', {
      url: retry.url, correlationId, reason: urlCheck.reason,
    });
    await WebhookRetry.updateOne(
      { _id: retry._id },
      { $set: { status: 'failed', lastError: 'Invalid or disallowed webhook URL', lastAttemptAt: new Date(), leasedAt: null, leasedBy: null } }
    );
    return;
  }

  const attemptNumber = retry.attemptCount + 1;

  const result = await _sendToUrl({
    url: retry.url,
    event: retry.event,
    filteredPayload: retry.payload,
    rawPayload: retry.payload,
    secret: retry.secret,
    deliveryId: retry.deliveryId,
    endpointId: retry.endpointId || null,
    schoolId: retry.schoolId || null,
    attemptCount: attemptNumber,
  });

  if (result.success) {
    await WebhookRetry.updateOne(
      { _id: retry._id },
      { $set: { status: 'succeeded', succeededAt: new Date(), lastAttemptAt: new Date(), leasedAt: null, leasedBy: null } }
    );
    return;
  }

  if (attemptNumber < retry.maxAttempts) {
    const nextRetryAt = new Date(Date.now() + getBackoffDelay(attemptNumber));
    await WebhookRetry.updateOne(
      { _id: retry._id },
      {
        $set: { status: 'pending', attemptCount: attemptNumber, nextRetryAt, lastError: result.error, lastAttemptAt: new Date(), leasedAt: null, leasedBy: null },
        $push: { errorLog: { attemptNumber, error: result.error, timestamp: new Date() } },
      }
    );
  } else {
    // Max retries exhausted — move to dead-letter
    logger.error('Webhook retry exhausted', {
      url: retry.url, event: retry.event, deliveryId: retry.deliveryId,
      correlationId, attempts: attemptNumber,
    });
    await WebhookRetry.updateOne(
      { _id: retry._id },
      {
        $set: { status: 'failed', attemptCount: attemptNumber, lastError: result.error, lastAttemptAt: new Date(), leasedAt: null, leasedBy: null },
        $push: { errorLog: { attemptNumber, error: result.error, timestamp: new Date() } },
      }
    );

    // #868: increment dead-letter metric
    try {
      const { recordDeliveryFailure } = require('../metrics/webhookMetrics');
      recordDeliveryFailure(retry.event, 0, true, retry.schoolId || 'unknown');
      // Refresh gauge asynchronously
      const { refreshDeadLetterGauge } = require('../metrics/webhookMetrics');
      refreshDeadLetterGauge().catch(() => {});
    } catch (_) {}
  }
}

// ── Public notify helpers ─────────────────────────────────────────────────────
// Each helper fires to all active WebhookEndpoint subscriptions for the school
// (#865). The rawPayload is PII-filtered per school config inside
// fireWebhookToEndpoints (#867).
// Falls back to the legacy single-URL path when no endpoints exist, to ensure
// backward-compatibility with schools that still have only webhookUrl on the
// School document.

async function _dispatchToSchool(schoolId, event, rawPayload, school) {
  // Try multi-endpoint path first
  const allowedFields = school?.webhookPayloadConfig?.allowedFields || null;
  const results = await fireWebhookToEndpoints(schoolId, event, rawPayload, allowedFields);

  // Fallback: legacy single-URL on the School document
  if (results.length === 0 && school?.webhookUrl) {
    const filteredPayload = buildWebhookPayload(rawPayload, allowedFields);
    return fireWebhook(school.webhookUrl, event, filteredPayload, school.webhookSecret || null);
  }

  return results;
}

async function notifyPaymentConfirmed(webhookUrl, payment, student, secret = null) {
  // Legacy direct-URL callers (e.g. paymentSavedSubscribers before migration)
  if (webhookUrl) {
    return fireWebhook(webhookUrl, 'payment.confirmed', {
      transactionHash: payment.transactionHash || payment.txHash,
      txHash: payment.txHash || payment.transactionHash,
      correlationId: payment.correlationId,
      studentId: payment.studentId,
      amount: payment.amount,
      assetCode: payment.assetCode || 'XLM',
      asset: payment.assetCode || 'XLM',
      finalFee: payment.finalFee,
      feeValidationStatus: payment.feeValidationStatus,
      confirmedAt: payment.confirmedAt,
      referenceCode: payment.referenceCode,
      schoolId: payment.schoolId,
      senderAddress: payment.senderAddress,
      status: payment.status,
      ts: new Date().toISOString(),
    }, secret);
  }
  return null;
}

async function notifyPaymentPending(webhookUrl, payment, secret = null) {
  if (webhookUrl) {
    return fireWebhook(webhookUrl, 'payment.pending', {
      transactionHash: payment.transactionHash || payment.txHash,
      txHash: payment.txHash || payment.transactionHash,
      correlationId: payment.correlationId,
      studentId: payment.studentId,
      amount: payment.amount,
      assetCode: payment.assetCode || 'XLM',
      asset: payment.assetCode || 'XLM',
      ledgerSequence: payment.ledgerSequence,
      status: 'pending_confirmation',
      ts: new Date().toISOString(),
    }, secret);
  }
  return null;
}

async function notifyPaymentFailed(webhookUrl, payment, reason, secret = null) {
  if (webhookUrl) {
    return fireWebhook(webhookUrl, 'payment.failed', {
      transactionHash: payment.transactionHash || payment.txHash,
      txHash: payment.txHash || payment.transactionHash,
      correlationId: payment.correlationId,
      studentId: payment.studentId,
      amount: payment.amount || 0,
      reason,
      status: 'FAILED',
      ts: new Date().toISOString(),
    }, secret);
  }
  return null;
}

async function notifyPaymentRefunded(webhookUrl, refundEvent, student, secret = null) {
  if (webhookUrl) {
    return fireWebhook(webhookUrl, 'payment.refunded', {
      originalTxHash: refundEvent.originalTxHash,
      refundTxHash: refundEvent.refundTxHash || null,
      studentId: refundEvent.studentId,
      amount: refundEvent.amount,
      reason: refundEvent.reason,
      status: refundEvent.newStatus,
      refundedAt: new Date().toISOString(),
      ts: new Date().toISOString(),
    }, secret);
  }
  return null;
}

async function notifyPaymentSuspicious(webhookUrl, payment, reason, secret = null) {
  if (webhookUrl) {
    return fireWebhook(webhookUrl, 'payment.suspicious', {
      transactionHash: payment.transactionHash || payment.txHash,
      txHash: payment.txHash || payment.transactionHash,
      correlationId: payment.correlationId,
      studentId: payment.studentId,
      amount: payment.amount,
      reason,
      isSuspicious: true,
      status: payment.status,
      ts: new Date().toISOString(),
    }, secret);
  }
  return null;
}

/** Legacy fire-and-forget helper used by concurrentPaymentProcessor. */
function sendPaymentWebhook(url, data, secret = null) {
  return fireWebhook(url, 'payment.confirmed', data, secret);
}

/**
 * Notify external system that a dispute has been opened for a payment.
 * Fires the 'dispute.created' event so the school's webhook receiver can
 * take immediate action (e.g. pause settlement, alert staff).
 *
 * @param {string} webhookUrl - Registered webhook URL
 * @param {object} dispute - Dispute document from MongoDB
 * @param {string|null} [secret] - Per-school HMAC secret
 */
async function notifyDisputeCreated(webhookUrl, dispute, secret = null) {
  return fireWebhook(webhookUrl, 'dispute.created', {
    disputeId:  dispute._id.toString(),
    schoolId:   dispute.schoolId,
    txHash:     dispute.txHash,
    studentId:  dispute.studentId,
    raisedBy:   dispute.raisedBy,
    reason:     dispute.reason,
    status:     dispute.status,
    holdSet:    true,
    createdAt:  dispute.createdAt,
  }, secret);
}

/**
 * Notify external system that a dispute has been resolved or rejected.
 * Fires the 'dispute.resolved' event so the school's webhook receiver can
 * resume normal processing for the affected payment/student.
 *
 * @param {string} webhookUrl - Registered webhook URL
 * @param {object} dispute - Updated Dispute document from MongoDB
 * @param {string|null} [secret] - Per-school HMAC secret
 */
async function notifyDisputeResolved(webhookUrl, dispute, secret = null) {
  return fireWebhook(webhookUrl, 'dispute.resolved', {
    disputeId:      dispute._id.toString(),
    schoolId:       dispute.schoolId,
    txHash:         dispute.txHash,
    studentId:      dispute.studentId,
    status:         dispute.status,
    resolvedBy:     dispute.resolvedBy,
    resolutionNote: dispute.resolutionNote,
    resolvedAt:     dispute.resolvedAt,
    holdLifted:     dispute.holdLifted ?? true,
  }, secret);
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  // Core dispatch
  fireWebhook,
  fireWebhookToEndpoints,
  sendPaymentWebhook,
  // Event helpers
  notifyPaymentConfirmed,
  notifyPaymentPending,
  notifyPaymentFailed,
  notifyPaymentRefunded,
  notifyPaymentSuspicious,
  notifyDisputeCreated,
  notifyDisputeResolved,
  // HMAC
  generateSignature,
  verifySignature,
  generateSignatureV2,
  verifySignatureV2,
  // Retry
  queueWebhookRetry,
  processPendingRetries,
  retryWebhook,
  recoverStuckLeases,
  getBackoffDelay,
  // Internal dispatch helper (exported for testing)
  _dispatchToSchool,
  // Testing internals
  _resetNonces,
  _writeDeliveryLog,
};
