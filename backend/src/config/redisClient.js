'use strict';

const logger = require('../utils/logger');

const REDIS_LOG_THROTTLE_MS = parseInt(process.env.REDIS_LOG_THROTTLE_MS || '60000', 10);
const REDIS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.REDIS_RECONNECT_MAX_ATTEMPTS || '8', 10);
const REDIS_RECONNECT_BASE_DELAY_MS = parseInt(process.env.REDIS_RECONNECT_BASE_DELAY_MS || '500', 10);
const REDIS_RECONNECT_MAX_DELAY_MS = parseInt(process.env.REDIS_RECONNECT_MAX_DELAY_MS || '30000', 10);

let client = null;
let subscriber = null;
let lastRedisWarningAt = 0;
let status = {
  configured: Boolean(process.env.REDIS_HOST),
  connected: false,
  status: process.env.REDIS_HOST ? 'unavailable' : 'disabled',
  reason: null,
  lastUpdatedAt: new Date().toISOString(),
};

function _throttleRedisWarning(message, meta = {}) {
  const now = Date.now();
  if (now - lastRedisWarningAt < REDIS_LOG_THROTTLE_MS) {
    logger.debug('[RedisClient] Suppressed duplicate warning', { message, ...meta });
    return;
  }
  lastRedisWarningAt = now;
  logger.warn('[RedisClient] ' + message, meta);
}

function _updateStatus(newStatus, reason = null) {
  status = {
    configured: status.configured,
    connected: newStatus === 'ready',
    status: newStatus,
    reason: reason || status.reason,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function _isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolve the Redis password from REDIS_URL (when it carries credentials) or
 * REDIS_PASSWORD. Never log the value.
 */
function _getRedisPassword() {
  if (process.env.REDIS_URL) {
    try {
      const parsed = new URL(process.env.REDIS_URL);
      if (parsed.password) {
        return decodeURIComponent(parsed.password);
      }
      if (parsed.username && !parsed.password) {
        // Redis 6+ ACL style: redis://user:pass@host — password is required.
        return undefined;
      }
    } catch (_) {
      // Malformed URL is reported by ioredis; fall through to REDIS_PASSWORD.
    }
  }
  return process.env.REDIS_PASSWORD || undefined;
}

/**
 * Issue #1963: Redis must be authenticated. In production, refuse to start
 * without a password rather than silently running unauthenticated.
 */
function assertRedisAuthConfigured() {
  const hasTarget = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
  if (!hasTarget) return;
  if (_getRedisPassword()) return;
  if (!_isProduction()) {
    _throttleRedisWarning('Redis is configured without a password (allowed outside production)');
    return;
  }
  throw new Error(
    'Redis authentication is required in production: set REDIS_PASSWORD or REDIS_URL with credentials',
  );
}

/**
 * Shared reconnection policy used by every Redis consumer (queue, SSE pub/sub,
 * distributed locks, rate limiter, refresh-token store). Centralising it here
 * means all consumers reconnect with the same exponential backoff and treat the
 * same error codes as transient — Issue #83: "Reconnection policy consistent".
 *
 * Pass overrides for connection-specific requirements. BullMQ Worker/QueueEvents
 * connections, for example, require `maxRetriesPerRequest: null`.
 *
 * @param {object} [overrides] Merged over the shared defaults.
 */
function getRedisConnectionOptions(overrides = {}) {
  const password = _getRedisPassword();
  const base = process.env.REDIS_URL
    ? {
        // ioredis accepts a URL string; credentials are parsed from it.
        // Keep the URL intact so TLS (rediss://) and db index are honoured.
        ...(password ? { password } : {}),
      }
    : {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        ...(password ? { password } : {}),
      };

  return {
    ...base,
    lazyConnect: true,
    enableOfflineQueue: false,
    // Must be null: this single shared client is also handed to BullMQ
    // (transactionRetryQueue), whose blocking Worker/QueueEvents connections
    // throw "Your redis options maxRetriesPerRequest must be null" otherwise.
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
    retryStrategy(times) {
      if (times >= REDIS_RECONNECT_MAX_ATTEMPTS) {
        return null;
      }
      return Math.min(
        REDIS_RECONNECT_BASE_DELAY_MS * Math.pow(2, times - 1),
        REDIS_RECONNECT_MAX_DELAY_MS,
      );
    },
    reconnectOnError(err) {
      if (!err || !err.message) return false;
      const transientCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'];
      return transientCodes.some((code) => err.message.includes(code));
    },
    ...overrides,
  };
}

function getRedisConfig() {
  return getRedisConnectionOptions();
}

function _describeTarget() {
  if (process.env.REDIS_URL) {
    try {
      const parsed = new URL(process.env.REDIS_URL);
      return { host: parsed.hostname, port: parsed.port || 6379, tls: parsed.protocol === 'rediss:' };
    } catch (_) {
      return { host: 'invalid-redis-url' };
    }
  }
  return { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT || 6379 };
}

function createRedisClient() {
  if (!process.env.REDIS_HOST && !process.env.REDIS_URL) {
    return null;
  }

  if (client) {
    return client;
  }

  assertRedisAuthConfigured();

  try {
    const Redis = require('ioredis');
    client = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, getRedisConfig())
      : new Redis(getRedisConfig());

    client.on('connect', () => {
      _updateStatus('connecting');
      logger.info('[RedisClient] connecting', _describeTarget());
    });

    client.on('ready', () => {
      _updateStatus('ready');
      status.reason = null;
      logger.info('[RedisClient] connected');
    });

    client.on('error', (err) => {
      _updateStatus('unavailable', err.message);
      _throttleRedisWarning('Redis unavailable', {
        error: err.message,
        ..._describeTarget(),
      });
    });

    client.on('close', () => {
      _updateStatus('closed', 'connection closed');
      _throttleRedisWarning('Redis connection closed', _describeTarget());
    });

    client.on('end', () => {
      _updateStatus('ended', 'connection ended');
      _throttleRedisWarning('Redis connection ended', _describeTarget());
    });

    client.on('reconnecting', (delay) => {
      _updateStatus('reconnecting', `retrying in ${delay}ms`);
      logger.debug('[RedisClient] reconnecting', { delay });
    });

    client.connect().catch((err) => {
      _throttleRedisWarning('Redis connection failed', { error: err.message });
    });
  } catch (err) {
    _updateStatus('unavailable', err.message);
    _throttleRedisWarning('Failed to create Redis client', { error: err.message });
    client = null;
  }

  return client;
}

function getRedisClient() {
  return client || createRedisClient();
}

/**
 * Return the process-wide subscriber connection. Redis pub/sub connections
 * cannot be used for regular commands, so consumers share this one duplicate
 * instead of opening a subscriber per service.
 */
function getRedisSubscriber() {
  const redisClient = getRedisClient();
  if (!redisClient) return null;
  if (subscriber) return subscriber;

  try {
    subscriber = redisClient.duplicate(getRedisConnectionOptions({
      maxRetriesPerRequest: null,
    }));
    subscriber.on('error', (err) => {
      _throttleRedisWarning('Redis subscriber unavailable', { error: err.message });
    });
    subscriber.connect().catch((err) => {
      _throttleRedisWarning('Redis subscriber connection failed', { error: err.message });
    });
  } catch (err) {
    _throttleRedisWarning('Failed to create Redis subscriber', { error: err.message });
    subscriber = null;
  }

  return subscriber;
}

function getRedisStatus() {
  return { ...status };
}

function isRedisReady() {
  return status.connected;
}

function resetRedisClient() {
  if (subscriber) {
    try {
      subscriber.quit().catch(() => logger.debug('[RedisClient] subscriber quit missed during reset'));
    } catch (_) {}
  }
  if (client) {
    try {
      client.quit().catch(() => logger.debug('[RedisClient] quit missed during reset'));
    } catch (_) {}
  }
  subscriber = null;
  client = null;
  lastRedisWarningAt = 0;
  status = {
    configured: Boolean(process.env.REDIS_HOST || process.env.REDIS_URL),
    connected: false,
    status: process.env.REDIS_HOST || process.env.REDIS_URL ? 'unavailable' : 'disabled',
    reason: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function closeRedisClients() {
  const connections = [...new Set([subscriber, client].filter(Boolean))];
  subscriber = null;
  client = null;

  const results = await Promise.allSettled(connections.map((connection) => connection.quit()));
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error('[RedisClient] Failed to close Redis connection', {
        error: result.reason?.message || String(result.reason),
      });
    }
  }
}

module.exports = {
  assertRedisAuthConfigured,
  createRedisClient,
  getRedisClient,
  getRedisSubscriber,
  getRedisConfig,
  getRedisConnectionOptions,
  getRedisStatus,
  isRedisReady,
  resetRedisClient,
  closeRedisClients,
};
