'use strict';

const logger = require('../utils/logger');

const REDIS_LOG_THROTTLE_MS = parseInt(process.env.REDIS_LOG_THROTTLE_MS || '60000', 10);
const REDIS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.REDIS_RECONNECT_MAX_ATTEMPTS || '8', 10);
const REDIS_RECONNECT_BASE_DELAY_MS = parseInt(process.env.REDIS_RECONNECT_BASE_DELAY_MS || '500', 10);
const REDIS_RECONNECT_MAX_DELAY_MS = parseInt(process.env.REDIS_RECONNECT_MAX_DELAY_MS || '30000', 10);

let client = null;
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
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
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

function createRedisClient() {
  if (!process.env.REDIS_HOST) {
    return null;
  }

  if (client) {
    return client;
  }

  try {
    const Redis = require('ioredis');
    client = new Redis(getRedisConfig());

    client.on('connect', () => {
      _updateStatus('connecting');
      logger.info('[RedisClient] connecting', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
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
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('close', () => {
      _updateStatus('closed', 'connection closed');
      _throttleRedisWarning('Redis connection closed', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('end', () => {
      _updateStatus('ended', 'connection ended');
      _throttleRedisWarning('Redis connection ended', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
      });
    });

    client.on('reconnecting', (delay) => {
      _updateStatus('reconnecting', `retrying in ${delay}ms`);
      logger.debug('[RedisClient] reconnecting', { delay });
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

function getRedisStatus() {
  return { ...status };
}

function isRedisReady() {
  return status.connected;
}

function resetRedisClient() {
  if (client) {
    try {
      client.quit().catch(() => logger.debug('[RedisClient] quit missed during reset'));
    } catch (_) {}
  }
  client = null;
  lastRedisWarningAt = 0;
  status = {
    configured: Boolean(process.env.REDIS_HOST),
    connected: false,
    status: process.env.REDIS_HOST ? 'unavailable' : 'disabled',
    reason: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

module.exports = {
  createRedisClient,
  getRedisClient,
  getRedisConfig,
  getRedisConnectionOptions,
  getRedisStatus,
  isRedisReady,
  resetRedisClient,
};
