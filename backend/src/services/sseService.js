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
 *
 * Issue #1054: When Redis pub/sub becomes unavailable, all locally-connected
 * clients receive an explicit `sse.degraded` event so the frontend can render
 * a visible warning banner. A corresponding `sse.recovered` event is emitted
 * when the publisher reconnects.
 */

const logger = require('../utils/logger').child('SSEService');
const {
  getRedisClient,
  getRedisSubscriber,
  getRedisStatus,
} = require('../config/redisClient');

// Map of schoolId -> Set of SSE response objects (process-local)
const clients = new Map();

const CHANNEL_PREFIX = 'sse:';
const HEARTBEAT_MS = parseInt(process.env.SSE_HEARTBEAT_MS, 10) || 15000;
const MAX_CONNECTIONS_PER_SCHOOL =
  parseInt(process.env.SSE_MAX_CONNECTIONS_PER_SCHOOL, 10) || 100;

// ── Redis pub/sub ───────────────────────────────────────────────────────────
// Only enabled when REDIS_HOST is set (mirrors the BullMQ/rate-limit backend
// selection). The process-wide command client publishes; services share one
// dedicated subscriber because subscriber connections cannot issue commands.
const redisEnabled = Boolean(process.env.REDIS_HOST);
const publisher = redisEnabled ? getRedisClient() : null;
const subscriber = redisEnabled ? getRedisSubscriber() : null;

// ── Degraded-mode tracking (Issue #1054) ────────────────────────────────────
// Tracks whether the Redis publisher is currently reachable. Only meaningful
// when redisEnabled is true; single-process deployments are always "healthy"
// because they never relied on Redis for fan-out.
let _publisherHealthy = !redisEnabled || getRedisStatus().connected;

/**
 * Broadcast a synthetic system event to every locally-connected client across
 * all schools. Used exclusively for degraded/recovered signals — do NOT route
 * these through Redis pub/sub (the whole point is that Redis may be down).
 */
function _broadcastSystemEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const set of clients.values()) {
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // Broken connections are cleaned up by the next fanout or heartbeat.
      }
    }
  }
}

function _onPublisherDown(reason) {
  if (_publisherHealthy) {
    _publisherHealthy = false;
    logger.warn('SSE Redis publisher unavailable — broadcasting degraded signal to clients', { reason });
    _broadcastSystemEvent('sse.degraded', {
      message: 'Real-time updates are temporarily limited to this server instance. '
        + 'Some events may not appear until connectivity is restored.',
      reason,
    });
  }
}

function _onPublisherUp() {
  if (!_publisherHealthy) {
    _publisherHealthy = true;
    logger.info('SSE Redis publisher reconnected — broadcasting recovered signal to clients');
    _broadcastSystemEvent('sse.recovered', {
      message: 'Real-time updates have been restored.',
    });
  }
}

if (publisher) {
  // Publisher health tracking for Issue #1054.
  // ioredis fires 'error' on connection failure and 'ready' when (re)connected.
  publisher.on('error', onPublisherError);
  publisher.on('ready', onPublisherReady);
  publisher.on('end', onPublisherEnd);
}

if (subscriber) {
  subscriber.on('message', onSubscriberMessage);
}

function onPublisherError(err) {
  logger.error('Redis publisher error', { error: err.message });
  _onPublisherDown(err.message);
}

function onPublisherReady() {
  _onPublisherUp();
}

function onPublisherEnd() {
  logger.error('Redis publisher connection ended');
  _onPublisherDown('connection ended');
}

function onSubscriberMessage(channel, message) {
  if (!channel.startsWith(CHANNEL_PREFIX)) return;
  const schoolId = channel.slice(CHANNEL_PREFIX.length);
  try {
    const { event, data } = JSON.parse(message);
    fanout(schoolId, event, data);
  } catch (err) {
    logger.error('Failed to handle SSE pub/sub message', { error: err.message, channel });
  }
}

/**
 * Returns true when Redis-backed cross-replica delivery is operating normally,
 * or when running in single-process mode (no Redis configured).
 * Exposed for /health reporting and for newly-connected clients that missed
 * the degraded broadcast.
 */
function isRedisHealthy() {
  return _publisherHealthy;
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

  // Issue #1054: If Redis is already degraded when this client connects, send
  // an immediate degraded signal so the client doesn't silently miss events
  // that were published before it arrived.
  if (redisEnabled && !_publisherHealthy) {
    try {
      res.write(
        'event: sse.degraded\ndata: '
        + JSON.stringify({
            message: 'Real-time updates are temporarily limited to this server instance. '
              + 'Some events may not appear until connectivity is restored.',
            reason: 'degraded at connect time',
          })
        + '\n\n'
      );
    } catch {
      // Connection already broken — removeClient will clean it up on next heartbeat.
    }
  }

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

  // Self-clean when the underlying connection closes so a dropped client is
  // never broadcast to again. Idempotent with any req.on('close') the caller
  // (e.g. the SSE controller) may also register — removeClient is a no-op the
  // second time.
  if (typeof res.on === 'function') {
    res.on('close', () => removeClient(schoolId, res));
  }

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
        // Issue #1054: signal all locally-connected clients that cross-replica
        // delivery is degraded so they can surface a visible warning.
        _onPublisherDown(err.message);
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
    closed += set.size;
    for (const res of set) {
      try {
        res.write(payload);
        if (res._sseHeartbeat) {
          clearInterval(res._sseHeartbeat);
          res._sseHeartbeat = null;
        }
        if (typeof res.end === 'function') res.end();
        removeClient(schoolId, res);
      } catch {
        // ignore write errors during shutdown
      }
    }
  }
  logger.info('[SSEService] Sent close/retry to all clients', { connections: closed });
}

/**
 * Release this service's subscriptions; Redis clients are closed centrally.
 */
async function close() {
  if (subscriber) {
    subscriber.removeListener('message', onSubscriberMessage);
    const channels = [...clients.keys()].map((schoolId) => `${CHANNEL_PREFIX}${schoolId}`);
    if (channels.length) {
      try {
        await subscriber.unsubscribe(...channels);
      } catch (err) {
        logger.error('Error unsubscribing SSE channels', { error: err.message });
      }
    }
  }
  if (publisher) {
    publisher.removeListener('error', onPublisherError);
    publisher.removeListener('ready', onPublisherReady);
    publisher.removeListener('end', onPublisherEnd);
  }
}

module.exports = {
  addClient,
  removeClient,
  emit,
  getStats,
  close,
  closeAll,
  isRedisHealthy,
  MAX_CONNECTIONS_PER_SCHOOL,
  // Exposed for testing
  _fanout: fanout,
  _broadcastSystemEvent,
};
