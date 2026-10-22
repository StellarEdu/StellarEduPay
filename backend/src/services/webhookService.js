'use strict';

const axios = require('axios');
const crypto = require('crypto');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const School = require('../models/schoolModel');
const WebhookRetry = require('../models/webhookRetryModel');
const WebhookEndpoint = require('../models/webhookEndpointModel');
const { decryptLeanEndpoint, TEST_EVENT } = require('../models/webhookEndpointModel');
const WebhookDelivery = require('../models/webhookDeliveryModel');
const { validateWebhookUrl, validateResolvedIp } = require('../utils/validateWebhookUrl');
const { resolveDnsWithCache } = require('../utils/dnsCache');
const { buildWebhookPayload } = require('../utils/buildWebhookPayload');
const { buildEventBody } = require('../utils/webhookEnvelope');
const {
  resolveSignatureVersions,
  signatureVersionLabel,
} = require('../utils/webhookSignaturePolicy');
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

/**
 * Format the X-StellarEduPay-Signature-V2 header value (#1639).
 *
 * Normally a single `sha256=<hex>`. During a secret-rotation overlap window
 * the header carries one value per active secret, newest first, separated by
 * commas (as Stripe does): `sha256=<new>,sha256=<previous>`. A receiver
 * accepts the delivery when any value matches its secret, so it keeps
 * verifying whether it has deployed the new secret yet or not.
 *
 * @param {number|string} timestamp
 * @param {string}        deliveryId
 * @param {string}        rawBody
 * @param {string[]}      secrets  Active secrets, newest first
 * @returns {string}
 */
function buildSignatureV2Header(timestamp, deliveryId, rawBody, secrets) {
  return secrets
    .filter(Boolean)
    .map((s) => `sha256=${generateSignatureV2(timestamp, deliveryId, rawBody, s)}`)
    .join(',');
}

/**
 * Verify an X-StellarEduPay-Signature-V2 header that may carry several
 * comma-separated `sha256=<hex>` values (#1639). Returns true when any value
 * matches `secret`.
 *
 * @param {number|string} timestamp
 * @param {string}        deliveryId
 * @param {string}        rawBody
 * @param {string}        headerValue
 * @param {string}        secret
 * @returns {boolean}
 */
function verifySignatureV2Header(timestamp, deliveryId, rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;
  return String(headerValue)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .some((v) => verifySignatureV2(
      timestamp, deliveryId, rawBody,
      v.startsWith('sha256=') ? v.slice(7) : v,
      secret,
    ));
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
 * #1497: the validated addresses are returned so the outgoing connection can
 * be pinned to them (see _buildPinnedLookup). Without pinning, Node's HTTP
 * stack would perform a second, independent DNS lookup at connect time and a
 * short-TTL rebinding attacker could serve a private IP to that lookup.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, reason?: string, addresses?: string[] }>}
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
    return check.blocked ? { ok: false, reason: check.reason } : { ok: true, addresses: [ip] };
  }

  // DNS re-resolution with TTL-aware caching (cache expires when TTL expires)
  let all;
  try {
    all = await resolveDnsWithCache(hostname);
  } catch {
    return { ok: false, reason: 'DNS_RESOLUTION_FAILED' };
  }

  if (!Array.isArray(all) || all.length === 0) {
    return { ok: false, reason: 'DNS_RESOLUTION_FAILED' };
  }
  for (const addr of all) {
    const check = validateResolvedIp(addr);
    if (check.blocked) return { ok: false, reason: check.reason };
  }
  return { ok: true, addresses: [...all] };
}

// ── Connection pinning — Issue #1497 ──────────────────────────────────────────
/**
 * Build a `lookup` function for http(s).Agent that never touches DNS and only
 * ever returns the addresses already validated by _validateAtSendTime. The
 * hostname is still used for the Host header and TLS SNI / certificate
 * verification, so HTTPS endpoints keep working unchanged.
 *
 * @param {string[]} addresses  Validated IPv4/IPv6 literals
 * @returns {Function} lookup(hostname, options, callback)
 */
function _buildPinnedLookup(addresses) {
  const entries = addresses
    .map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }))
    .filter((e) => net.isIP(e.address));

  return function pinnedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    const wanted = opts.family === 4 || opts.family === 6
      ? entries.filter((e) => e.family === opts.family)
      : entries;

    if (wanted.length === 0) {
      const err = new Error(`No validated address for ${hostname}`);
      err.code = 'ENOTFOUND';
      return process.nextTick(callback, err);
    }
    if (opts.all) return process.nextTick(callback, null, wanted);
    return process.nextTick(callback, null, wanted[0].address, wanted[0].family);
  };
}

// ── Axios instance with SSRF-safe defaults ────────────────────────────────────
/**
 * Build a per-request Axios instance.
 * - maxRedirects: 0 disables redirect following entirely.
 * - maxContentLength caps response body at 64 KB.
 * - timeout of 10 s matches WEBHOOK_TIMEOUT_MS.
 * - #1497: when `addresses` is given, the http/https agents resolve the
 *   hostname only to those pre-validated IPs, closing the DNS-rebinding
 *   window between validation and connect. Agents are per-request (no
 *   keep-alive) so a pooled socket can never outlive its validation.
 *
 * @param {string[]} [addresses]
 */
function _buildAxiosInstance(addresses) {
  const config = {
    timeout: WEBHOOK_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: Infinity,
    proxy: false,
  };
  if (Array.isArray(addresses) && addresses.length > 0) {
    const lookup = _buildPinnedLookup(addresses);
    config.httpAgent = new http.Agent({ keepAlive: false, lookup });
    config.httpsAgent = new https.Agent({ keepAlive: false, lookup });
  }
  return axios.create(config);
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

// ── Signing context — Issues #1538 / #1539 ───────────────────────────────────

/**
 * Return the endpoint's previous secret if its rotation overlap window is
 * still open, otherwise null.
 *
 * @param {object} ep  WebhookEndpoint (document or decrypted lean object)
 * @param {Date} [now]
 * @returns {string|null}
 */
function _activePreviousSecret(ep, now = new Date()) {
  if (!ep || !ep.previousSecret || !ep.previousSecretExpiresAt) return null;
  return new Date(ep.previousSecretExpiresAt).getTime() > now.getTime() ? ep.previousSecret : null;
}

/**
 * Resolve the secret(s) and signature versions for a delivery at send time.
 *
 *   - endpointId → the WebhookEndpoint's (decrypted) secret, overlap secret and
 *                  signatureVersions
 *
 * Falls back to the explicitly passed secret when nothing can be loaded. The
 * School.webhookSecret fallback was removed with the legacy delivery path
 * (#1640); retries queued before migration 036 are re-pointed at the
 * migrated endpoint by that migration.
 *
 * @param {object} opts
 * @param {string|null} opts.endpointId
 * @param {string|null} opts.schoolId
 * @param {string|null} opts.secret
 * @returns {Promise<{secret: string|null, previousSecret: string|null, signatureVersions: string[]|null}>}
 */
async function _resolveSigningContext({ endpointId = null, schoolId = null, secret = null }) {
  try {
    if (endpointId) {
      const ep = decryptLeanEndpoint(
        await WebhookEndpoint.findById(endpointId).select('+secret +previousSecret').lean()
      );
      if (ep) {
        return {
          secret: ep.secret || secret || null,
          previousSecret: _activePreviousSecret(ep),
          signatureVersions: ep.signatureVersions || null,
        };
      }
    }
  } catch (err) {
    logger.warn('Failed to resolve webhook signing context', { endpointId, schoolId, error: err.message });
  }
  return { secret: secret || null, previousSecret: null, signatureVersions: null };
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
 * @param {string|null} [opts.previousSecret]  Secret replaced by a rotation; while
 *                                     still inside its overlap window the delivery
 *                                     is additionally signed with it (#1538)
 * @param {string[]|null} [opts.signatureVersions]  Endpoint's signature versions
 *                                     (#1539). null → legacy ['v1','v2'].
 * @param {string}  opts.deliveryId
 * @param {string|null} opts.endpointId    ObjectId string of WebhookEndpoint (null for legacy)
 * @param {string|null} opts.schoolId
 * @param {number}  [opts.attemptCount=1]
 * @returns {Promise<{success: boolean, statusCode?: number, error?: string, deliveryId: string, durationMs: number}>}
 */
async function _sendToUrl({
  url, event, filteredPayload, rawPayload, secret, deliveryId,
  endpointId = null, schoolId = null, attemptCount = 1,
  previousSecret = null, signatureVersions = null, sequence = null,
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
    return { success: false, error: 'SSRF_BLOCKED', deliveryId, durationMs: 0 };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const body = buildEventBody({
    event,
    timestamp: new Date(timestamp * 1000).toISOString(),
    data: filteredPayload,
    sequence,
  });

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
  // #1539: which signature headers to emit is decided per endpoint and by the
  // WEBHOOK_V1_SUNSET date — see utils/webhookSignaturePolicy.js.
  const versions = resolveSignatureVersions(signatureVersions);
  const sigLabel = signatureVersionLabel(versions, Boolean(secret));
  if (secret) {
    if (versions.includes('v1')) {
      // V1 — deprecated, emitted only for endpoints that still opt in and only
      // until the sunset date. Signs JSON.stringify(body) only; timestamp and
      // deliveryId are NOT covered. Computed over rawBody so it always matches
      // the transmitted bytes.
      headers['X-StellarEduPay-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    }
    if (versions.includes('v2')) {
      // V2 — signs `timestamp.deliveryId.rawBody` so the timestamp and delivery-ID
      // are bound to the signature and cannot be rewritten by an attacker.
      // #1639: during a secret-rotation overlap window the header carries one
      // value per active secret (new first), so receivers verify against
      // either secret without dropping events.
      headers['X-StellarEduPay-Signature-V2'] = buildSignatureV2Header(
        timestamp, deliveryId, rawBody, [secret, previousSecret],
      );
      // #1538: the previous-secret signature is also sent on its own header
      // for receivers written against that contract.
      if (previousSecret) {
        headers['X-StellarEduPay-Signature-V2-Previous'] = `sha256=${generateSignatureV2(timestamp, deliveryId, rawBody, previousSecret)}`;
      }
    }
  }

  // Generic tracing header (#978); the vendor-specific correlation + signature
  // headers are already set above.
  if (correlationId) headers['X-Correlation-ID'] = correlationId;

  // #1497: pin the connection to the addresses validated above.
  const client = _buildAxiosInstance(sendCheck.addresses);
  const startTime = Date.now();

  try {
    const response = await client.post(url, rawBody, {
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
      recordDeliverySuccess(event, durationMs, sigLabel);
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

    return { success: true, statusCode: response.status, deliveryId, durationMs };

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
      recordDeliveryFailure(event, durationMs, false, schoolId, sigLabel);
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

    return { success: false, statusCode, error: errorMessage, deliveryId, durationMs };
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
/**
 * Atomically allocates the next per-endpoint event sequence (#1815).
 * The counter is incremented in the database, so concurrent workers never
 * hand out the same number.
 */
async function _nextEndpointSequence(endpointId) {
  const updated = await WebhookEndpoint.findByIdAndUpdate(
    endpointId,
    { $inc: { eventSequence: 1 } },
    { new: true, projection: { eventSequence: 1 } },
  ).lean();
  return updated ? updated.eventSequence : null;
}

async function fireWebhookToEndpoints(schoolId, event, rawPayload, allowedFields = null) {
  // #867: build the PII-filtered payload once for all endpoints of this school
  const filteredPayload = buildWebhookPayload(rawPayload, allowedFields);

  // #865: query active endpoints subscribed to this event
  // #1538: secrets are select:false and encrypted at rest — opt in explicitly
  // and decrypt (lean() skips the model's post('init') decryption hook).
  const endpoints = (await WebhookEndpoint.find({
    schoolId,
    isActive: true,
    subscribedEvents: event,
  }).select('+secret +previousSecret').lean()).map(decryptLeanEndpoint);

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

    // #1815: allocate the endpoint's next sequence number once per delivery;
    // retries of this delivery reuse it.
    const sequence = await _nextEndpointSequence(ep._id);

    const result = await _sendToUrl({
      url: ep.url,
      event,
      filteredPayload,
      rawPayload,
      secret: ep.secret,
      previousSecret: _activePreviousSecret(ep),
      signatureVersions: ep.signatureVersions,
      deliveryId,
      endpointId: ep._id,
      schoolId,
      attemptCount: 1,
      sequence,
    });

    // Queue for retry on failure
    if (!result.success) {
      try {
        await queueWebhookRetry(ep.url, event, rawPayload, result.error, ep.secret, deliveryId, ep._id, schoolId, sequence);
      } catch (qErr) {
        logger.error('Failed to queue webhook retry', { endpointId: ep._id, error: qErr.message });
      }
    }

    results.push({ endpointId: ep._id, ...result });
  }

  return results;
}

/**
 * Single-URL delivery — used by direct callers that pass a URL explicitly
 * (delivery replay, DLQ replay). School events go through dispatchToSchool().
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
 * @param {object} [signing]           Optional signing options (#1538, #1539)
 * @param {string|null} [signing.previousSecret]
 * @param {string[]|null} [signing.signatureVersions]
 *   When omitted and endpointId is given, both are loaded from the endpoint.
 * @returns {Promise<{success, statusCode?, error?, queued?, deliveryId}>}
 */
async function fireWebhook(url, event, payload, secret = null, deliveryId = null, endpointId = null, schoolId = null, signing = null) {
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

  const signingCtx = signing || (endpointId
    ? await _resolveSigningContext({ endpointId, schoolId, secret })
    : { secret, previousSecret: null, signatureVersions: null });

  const result = await _sendToUrl({
    url, event,
    filteredPayload: payload,
    rawPayload: payload,
    secret: signing ? secret : signingCtx.secret,
    previousSecret: signingCtx.previousSecret || null,
    signatureVersions: signingCtx.signatureVersions || null,
    deliveryId: id,
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

// ── Test delivery — Issue #1639 ──────────────────────────────────────────────
/**
 * Sample data carried by a webhook.test delivery. Shaped like a
 * payment.confirmed payload so integrators can exercise their parser, but
 * flagged `test: true` and using obviously fake identifiers.
 */
function _buildTestPayload(schoolId) {
  return {
    test: true,
    message: 'This is a test webhook event from StellarEduPay.',
    schoolId,
    txHash: '0'.repeat(64),
    transactionHash: '0'.repeat(64),
    amount: '100.0000000',
    asset: 'XLM',
    assetCode: 'XLM',
    status: 'SUCCESS',
    referenceCode: 'TEST-0000',
    ts: new Date().toISOString(),
  };
}

/**
 * Send a signed `webhook.test` event to one endpoint through the normal
 * signing/delivery path (send-time SSRF checks, endpoint signature versions,
 * rotation dual-signing, delivery log) and report the receiver's response.
 *
 * Unlike real events a failed test is NOT queued for retry — the caller sees
 * the result immediately and fixes the receiver.
 *
 * @param {object} endpoint  WebhookEndpoint loaded with +secret +previousSecret
 * @returns {Promise<{success: boolean, statusCode: number|null, durationMs: number,
 *   error: string|null, deliveryId: string, event: string}>}
 */
async function sendTestDelivery(endpoint) {
  const deliveryId = uuidv4();
  const schoolId = endpoint.schoolId;
  const payload = _buildTestPayload(schoolId);

  const urlCheck = await validateWebhookUrl(endpoint.url);
  if (!urlCheck.valid) {
    await _writeDeliveryLog({
      endpointId: endpoint._id, schoolId, deliveryId, event: TEST_EVENT,
      payload, statusCode: null, responseBody: null, success: false,
      attemptCount: 1, durationMs: 0, error: 'URL_VALIDATION_FAILED',
    });
    return { success: false, statusCode: null, durationMs: 0, error: 'URL_VALIDATION_FAILED', deliveryId, event: TEST_EVENT };
  }

  const result = await _sendToUrl({
    url: endpoint.url,
    event: TEST_EVENT,
    filteredPayload: payload,
    rawPayload: payload,
    secret: endpoint.secret,
    previousSecret: _activePreviousSecret(endpoint),
    signatureVersions: endpoint.signatureVersions || null,
    deliveryId,
    endpointId: endpoint._id,
    schoolId,
    attemptCount: 1,
  });

  return {
    success: result.success,
    statusCode: result.statusCode ?? null,
    durationMs: result.durationMs ?? 0,
    error: result.error || null,
    deliveryId,
    event: TEST_EVENT,
  };
}

// ── Retry queue ───────────────────────────────────────────────────────────────
async function queueWebhookRetry(url, event, payload, error, secret = null, deliveryId = null, endpointId = null, schoolId = null, sequence = null) {
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
    sequence: sequence ?? null,
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

  // The signing secret is never persisted on WebhookRetry (Issue #75) — resolve
  // it (and the endpoint's signature versions, #1539) at send time.
  const signingCtx = await _resolveSigningContext({
    endpointId: retry.endpointId || null,
    schoolId: retry.schoolId || null,
    secret: retry.secret || null,
  });

  const result = await _sendToUrl({
    url: retry.url,
    event: retry.event,
    filteredPayload: retry.payload,
    rawPayload: retry.payload,
    sequence: retry.sequence ?? null,
    secret: signingCtx.secret,
    previousSecret: signingCtx.previousSecret,
    signatureVersions: signingCtx.signatureVersions,
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
      recordDeliveryFailure(
        retry.event, 0, true, retry.schoolId || 'unknown',
        signatureVersionLabel(resolveSignatureVersions(signingCtx.signatureVersions), Boolean(signingCtx.secret)),
      );
      // Refresh gauge asynchronously
      const { refreshDeadLetterGauge } = require('../metrics/webhookMetrics');
      refreshDeadLetterGauge().catch(() => {});
    } catch (_) {}
  }
}

// ── School event dispatch — Issue #1640 ─────────────────────────────────────
// WebhookEndpoint is the only outbound webhook configuration model. Every
// school event is delivered to the school's active endpoints subscribed to it;
// the former School.webhookUrl fallback has been removed (schools that used it
// were converted to endpoints by migration 036).

/**
 * Deliver a school event to every active endpoint subscribed to it, with the
 * payload PII-filtered by the school's webhookPayloadConfig (#867).
 *
 * @param {string} schoolId
 * @param {string} event
 * @param {object} rawPayload
 * @param {object} [school]  Pre-loaded School document (avoids a lookup)
 * @returns {Promise<Array<{endpointId, success, statusCode?, error?, deliveryId}>>}
 */
async function dispatchToSchool(schoolId, event, rawPayload, school = undefined) {
  if (!schoolId) return [];
  const doc = school !== undefined
    ? school
    : await School.findOne({ schoolId }).select('webhookPayloadConfig').lean();
  const allowedFields = doc?.webhookPayloadConfig?.allowedFields || null;
  return fireWebhookToEndpoints(schoolId, event, rawPayload, allowedFields);
}

/**
 * Notify the school's endpoints that a dispute has been opened.
 *
 * @param {object} dispute  Dispute document
 */
async function notifyDisputeCreated(dispute) {
  return dispatchToSchool(dispute.schoolId, 'dispute.created', {
    disputeId:  dispute._id.toString(),
    schoolId:   dispute.schoolId,
    txHash:     dispute.txHash,
    studentId:  dispute.studentId,
    raisedBy:   dispute.raisedBy,
    reason:     dispute.reason,
    status:     dispute.status,
    holdSet:    true,
    slaDeadline: dispute.slaDeadline || null,
    createdAt:  dispute.createdAt,
  });
}

/**
 * Notify the school's endpoints that a dispute has been resolved or rejected
 * (`status` carries the outcome).
 *
 * @param {object} dispute  Updated Dispute document
 */
async function notifyDisputeResolved(dispute) {
  return dispatchToSchool(dispute.schoolId, 'dispute.resolved', {
    disputeId:      dispute._id.toString(),
    schoolId:       dispute.schoolId,
    txHash:         dispute.txHash,
    studentId:      dispute.studentId,
    status:         dispute.status,
    resolvedBy:     dispute.resolvedBy,
    resolutionNote: dispute.resolutionNote,
    resolvedAt:     dispute.resolvedAt,
    holdLifted:     dispute.holdLifted ?? true,
  });
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  // Core dispatch
  fireWebhook,
  fireWebhookToEndpoints,
  dispatchToSchool,
  sendTestDelivery,
  // Event helpers
  notifyDisputeCreated,
  notifyDisputeResolved,
  // HMAC
  generateSignature,
  verifySignature,
  generateSignatureV2,
  verifySignatureV2,
  buildSignatureV2Header,
  verifySignatureV2Header,
  // Retry
  queueWebhookRetry,
  processPendingRetries,
  retryWebhook,
  recoverStuckLeases,
  getBackoffDelay,
  // Testing internals
  _resetNonces,
  _writeDeliveryLog,
  _validateAtSendTime,
  _buildPinnedLookup,
  _buildAxiosInstance,
};
