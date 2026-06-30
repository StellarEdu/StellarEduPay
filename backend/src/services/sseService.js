'use strict';

/**
 * Server-Sent Events fan-out service.
 *
 * Each replica keeps a process-local registry of connected `res` objects
 * (schoolId -> Set<res>). To make delivery correct across horizontally-scaled
 * replicas (Docker compose / PM2 cluster), emits are routed through a Redis
 * pub/sub channel `sse:<schoolId>`:
 *
 *   emit()  -> PUBLISH sse:<schoolId>                 (any replica)
 *   each replica's subscriber receives the message -> fans out to its own
 *   locally-connected clients for that school.
 *
 * A replica only subscribes to a school's channel while it holds at least one
 * local connection for that school, and unsubscribes when the last one closes.
 *
 * When REDIS_HOST is not configured the service degrades to single-process
 * mode: emit() fans out locally and cross-replica delivery is unavailable
 * (correct for a single replica).
 */

const Redis = require('ioredis');
const logger = require('../utils/logger').child('SSEService');
const { getRedisConnectionOptions } = require('../config/redisClient');

// Map of schoolId -> Set of SSE response objects (process-local)
const clients = new Map();

const CHANNEL_PREFIX = 'sse:';
const HEARTBEAT_MS = parseInt(process.env.SSE_HEARTBEAT_MS, 10) || 15000;
const MAX_CONNECTIONS_PER_SCHOOL =
  parseInt(process.env.SSE_MAX_CONNECTIONS_PER_SCHOOL, 10) || 100;

// ── Redis pub/sub ───────────────────────────────────────────────────────────
// Only enabled when REDIS_HOST is set (mirrors the BullMQ/rate-limit backend
// selection). Two dedicated connections are required: a subscriber connection
// cannot issue regular commands such as PUBLISH.
const redisEnabled = Boolean(process.env.REDIS_HOST);

// Shared reconnection policy (Issue #83). pub/sub connections need
// maxRetriesPerRequest: null so a blocking SUBSCRIBE survives a reconnect; on a
// total outage emit() degrades to local fan-out (see emit() below).
const redisConfig = getRedisConnectionOptions({ maxRetriesPerRequest: null });

let publisher = null;
let subscriber = null;

if (redisEnabled) {
  publisher = new Redis(redisConfig);
  subscriber = new Redis(redisConfig);

  for (const [name, conn] of [['publisher', publisher], ['subscriber', subscriber]]) {
    conn.on('error', (err) => logger.error(`Redis ${name} error`, { error: err.message }));
    conn.connect().catch((err) =>
      logger.error(`Redis ${name} connect failed`, { error: err.message })
    );
  }

  subscriber.on('message', (channel, message) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const schoolId = channel.slice(CHANNEL_PREFIX.length);
    try {
      const { event, data } = JSON.parse(message);
      fanout(schoolId, event, data);
    } catch (err) {
      logger.error('Failed to handle SSE pub/sub message', { error: err.message, channel });
    }
  });
}

function subscribeSchool(schoolId) {
  if (!subscriber) return;
  subscriber
    .subscribe(`${CHANNEL_PREFIX}${schoolId}`)
    .catch((err) => logger.error('SSE subscribe failed', { error: err.message, schoolId }));
}

function unsubscribeSchool(schoolId) {
  if (!subscriber) return;
  subscriber
    .unsubscribe(`${CHANNEL_PREFIX}${schoolId}`)
    .catch((err) => logger.error('SSE unsubscribe failed', { error: err.message, schoolId }));
}

// ── Connection registry ──────────────────────────────────────────────────────

/**
 * Register a connected SSE client.
 *
 * Enforces SSE_MAX_CONNECTIONS_PER_SCHOOL to prevent file-descriptor
 * exhaustion. Starts a per-connection heartbeat so idle proxies don't drop
 * the connection.
 *
 * @returns {boolean} false if the per-school connection cap is reached and the
 *                    caller should reject the connection.
 */
function addClient(schoolId, res) {
  let set = clients.get(schoolId);

  if (set && set.size >= MAX_CONNECTIONS_PER_SCHOOL) {
    logger.warn('SSE connection rejected — per-school cap reached', {
      schoolId,
      cap: MAX_CONNECTIONS_PER_SCHOOL,
    });
    return false;
  }

  if (!set) {
    set = new Set();
    clients.set(schoolId, set);
    subscribeSchool(schoolId);
  }
  set.add(res);

  // Per-connection heartbeat: a comment line keeps idle connections (and the
  // proxies in front of them) alive without producing a client-visible event.
  res._sseHeartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      removeClient(schoolId, res);
    }
  }, HEARTBEAT_MS);
  if (typeof res._sseHeartbeat.unref === 'function') res._sseHeartbeat.unref();

  return true;
}

function removeClient(schoolId, res) {
  if (res._sseHeartbeat) {
    clearInterval(res._sseHeartbeat);
    res._sseHeartbeat = null;
  }

  const set = clients.get(schoolId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    clients.delete(schoolId);
    unsubscribeSchool(schoolId);
  }
}

/**
 * Write an event to every locally-connected client for a school.
 * Invoked directly in single-process mode, and by the Redis subscriber
 * callback when running multi-replica.
 */
function fanout(schoolId, event, data) {
  const set = clients.get(schoolId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  logger.debug('SSE event fanned out', {
    schoolId,
    event,
    correlationId: data?.correlationId || null,
    connections: set.size,
  });
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      removeClient(schoolId, res);
    }
  }
}

/**
 * Emit an event to all SSE clients for a school, across every replica.
 *
 * With Redis enabled the event is published and every replica (including this
 * one) fans out via its subscriber — so we must NOT also fan out locally here,
 * or this replica would deliver twice.
 *
 * @param {string} schoolId
 * @param {string} event
 * @param {object} data
 * @param {string} [correlationId] - Optional correlation ID to include in the payload
 */
function emit(schoolId, event, data, correlationId) {
  const enrichedData = correlationId
    ? { ...data, correlationId }
    : data;

  if (publisher) {
    publisher
      .publish(`${CHANNEL_PREFIX}${schoolId}`, JSON.stringify({ event, data: enrichedData }))
      .catch((err) => {
        // Best-effort fallback so a transient publish failure still reaches
        // clients on this replica.
        logger.error('SSE publish failed — falling back to local fanout', {
          error: err.message,
          schoolId,
          correlationId: correlationId || enrichedData?.correlationId || null,
        });
        fanout(schoolId, event, enrichedData);
      });
    return;
  }
  fanout(schoolId, event, enrichedData);
}

/**
 * Current connection counts for /metrics.
 */
function getStats() {
  let connections = 0;
  for (const set of clients.values()) connections += set.size;
  return { schools: clients.size, connections };
}

/**
 * Close all SSE connections with a close/retry event so clients reconnect.
 * Called during graceful shutdown to notify clients to reconnect.
 */
async function closeAll() {
  const payload = 'event: retry\ndata: {"retry": true}\n\n';
  let closed = 0;
  for (const [schoolId, set] of clients) {
    for (const res of set) {
      try {
        res.write(payload);
        if (res._sseHeartbeat) {
          clearInterval(res._sseHeartbeat);
          res._sseHeartbeat = null;
        }
      } catch {
        // ignore write errors during shutdown
      }
    }
    closed += set.size;
  }
  logger.info('[SSEService] Sent close/retry to all clients', { connections: closed });
}

/**
 * Close Redis connections during graceful shutdown.
 */
async function close() {
  try {
    if (subscriber) await subscriber.quit();
    if (publisher) await publisher.quit();
  } catch (err) {
    logger.error('Error closing SSE Redis connections', { error: err.message });
  }
}

module.exports = {
  addClient,
  removeClient,
  emit,
  getStats,
  close,
  closeAll,
  MAX_CONNECTIONS_PER_SCHOOL,
  // Exposed for testing
  _fanout: fanout,
};
