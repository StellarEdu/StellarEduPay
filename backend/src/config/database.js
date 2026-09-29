/**
 * Database Configuration with Connection Pooling
 * 
 * Production-ready MongoDB connection settings optimized for high-traffic
 * financial transaction processing with proper concurrency handling.
 *
 * All environment variables are read through the central `config` module so
 * that values are validated once at startup (see ./index.js) instead of being
 * parsed ad hoc here.
 */

'use strict';

const mongoose = require('mongoose');
const { logger } = require('../utils/logger');
const config = require('./index');

// ── Connection Pool Configuration ──────────────────────────────────────────────
const POOL_CONFIG = {
  // Maximum number of sockets in the connection pool.
  // MONGODB_POOL_SIZE is the canonical env var (default: 20).
  // DB_MAX_POOL_SIZE is also accepted for backward compatibility.
  maxPoolSize: config.db.maxPoolSize,
  
  // Minimum number of sockets in the connection pool
  minPoolSize: config.db.minPoolSize,
  
  // Maximum time in milliseconds a socket can remain idle
  maxIdleTimeMS: config.db.maxIdleTimeMS,
  
  // Connection timeout in milliseconds
  connectTimeoutMS: config.db.connectTimeoutMS,
  
  // Socket timeout in milliseconds (default: 45000)
  socketTimeoutMS: config.db.socketTimeoutMS,

  // Server selection timeout in milliseconds (default: 5000)
  serverSelectionTimeoutMS: config.db.serverSelectionTimeoutMS,
  
  // Maximum number of concurrent operations
  maxConcurrent: config.db.maxConcurrent,

  // Server-side ceiling on a single report aggregation, in milliseconds
  // (default: 15000). socketTimeoutMS only abandons the client's socket — the
  // server keeps executing the pipeline and keeps holding its connection.
  // maxTimeMS is what actually makes the server stop, so a slow report cannot
  // pin a pool connection for the length of the query.
  reportAggregationMaxTimeMS: config.db.reportAggregationMaxTimeMS,
};

// ── Retry Configuration ─────────────────────────────────────────────────────────
const RETRY_CONFIG = {
  // Maximum number of retry attempts for transient errors
  maxRetries: config.db.maxRetries,
  
  // Initial retry delay in milliseconds (exponential backoff)
  initialRetryDelayMs: config.db.initialRetryDelayMs,
  
  // Maximum retry delay in milliseconds
  maxRetryDelayMs: config.db.maxRetryDelayMs,
};

// ── Startup Connection Retry Configuration ──────────────────────────────────────
const STARTUP_RETRY_CONFIG = {
  // Maximum number of retry attempts on startup (default: 5)
  maxRetries: config.db.connectRetries,
  
  // Initial retry delay in milliseconds (default: 2000)
  initialDelayMs: config.db.connectDelayMs,
};

// ── Transaction Configuration ───────────────────────────────────────────────────
const TRANSACTION_CONFIG = {
  // Read concern level for transactions
  readConcern: config.db.readConcern,
  
  // Write concern level for transactions
  writeConcern: config.db.writeConcern,
  
  // Journal sync mode
  journal: config.db.journal,
  
  // Transaction timeout in milliseconds
  transactionTimeoutMs: config.db.transactionTimeoutMs,
};

// ── Connection State Tracking ───────────────────────────────────────────────────
let connectionState = {
  isConnected: false,
  isConnecting: false,
  reconnectAttempts: 0,
  lastConnectedAt: null,
  currentSession: null,
};

// ── Event Handlers ──────────────────────────────────────────────────────────────
function setupConnectionEventHandlers() {
  mongoose.connection.on('connected', () => {
    connectionState.isConnected = true;
    connectionState.reconnectAttempts = 0;
    connectionState.lastConnectedAt = new Date();
    logger.info('[MongoDB] Connected successfully', {
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      name: mongoose.connection.name,
      poolSize: mongoose.connection.base.poolConfig?.size,
    });
  });

  mongoose.connection.on('error', (err) => {
    logger.error('[MongoDB] Connection error', { error: err.message, stack: err.stack });
    try {
      const { mongoConnectionErrorsTotal } = require('../metrics');
      if (mongoConnectionErrorsTotal) mongoConnectionErrorsTotal.inc();
    } catch (_) {
      // metrics optional (tests / early boot)
    }
  });

  mongoose.connection.on('disconnected', () => {
    connectionState.isConnected = false;
    logger.warn('[MongoDB] Disconnected', { reconnectAttempts: connectionState.reconnectAttempts });
  });

  mongoose.connection.on('reconnected', () => {
    connectionState.isConnected = true;
    connectionState.reconnectAttempts = 0;
    logger.info('[MongoDB] Reconnected successfully');
  });

  mongoose.connection.on('close', () => {
    connectionState.isConnected = false;
    logger.info('[MongoDB] Connection closed');
  });
}

// ── Exponential Backoff Calculator ─────────────────────────────────────────────
function calculateRetryDelay(attempt) {
  const delay = RETRY_CONFIG.initialRetryDelayMs * Math.pow(2, attempt);
  return Math.min(delay, RETRY_CONFIG.maxRetryDelayMs);
}

// ── Connect with Retry Logic ────────────────────────────────────────────────────
async function connectWithRetry(uri, options = {}, retryCount = 0) {
  try {
    connectionState.isConnecting = true;
    await mongoose.connect(uri, {
      ...options,
      // Pool configuration
      maxPoolSize: POOL_CONFIG.maxPoolSize,
      minPoolSize: POOL_CONFIG.minPoolSize,
      maxIdleTimeMS: POOL_CONFIG.maxIdleTimeMS,
      // Timeout configuration
      connectTimeoutMS: POOL_CONFIG.connectTimeoutMS,
      socketTimeoutMS: POOL_CONFIG.socketTimeoutMS,
      // Server selection
      serverSelectionTimeoutMS: POOL_CONFIG.serverSelectionTimeoutMS,
      // Retry configuration
      retryWrites: true,
      retryReads: true,
      // Write concern for financial data durability — ensures writes survive replica set failover
      w: 'majority',
      readPreference: 'primaryPreferred',
    });
    connectionState.isConnecting = false;
    return mongoose.connection;
  } catch (error) {
    connectionState.isConnecting = false;
    connectionState.reconnectAttempts = retryCount + 1;

    // Check if we should retry
    const isTransientError = isTransientConnectionError(error);
    
    if (isTransientError && retryCount < RETRY_CONFIG.maxRetries) {
      const delay = calculateRetryDelay(retryCount);
      logger.warn(`[MongoDB] Connection failed, retrying in ${delay}ms`, {
        attempt: retryCount + 1,
        maxRetries: RETRY_CONFIG.maxRetries,
        error: error.message,
      });
      
      await sleep(delay);
      return connectWithRetry(uri, options, retryCount + 1);
    }

    logger.error('[MongoDB] Connection failed permanently', {
      attempts: retryCount + 1,
      error: error.message,
    });
    throw error;
  }
}

// ── Check for Transient Errors ──────────────────────────────────────────────────
function isTransientConnectionError(error) {
  const transientCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ETIMEDOUT',
    'socket hang up',
    ' TopologyDestroyed',
    'Transaction numbers',
  ];
  
  return (
    transientCodes.some(code => error.message?.includes(code)) ||
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT'
  );
}

// ── Utility: Sleep ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main Connection Function ────────────────────────────────────────────────────
async function connect() {
  const MONGO_URI = config.mongoUri;
  
  if (!MONGO_URI) {
    throw new Error('MONGO_URI environment variable is required');
  }

  setupConnectionEventHandlers();

  logger.info('[MongoDB] Connecting...', {
    poolSize: POOL_CONFIG.maxPoolSize,
    minPoolSize: POOL_CONFIG.minPoolSize,
  });

  return connectWithRetry(MONGO_URI);
}

// ── Disconnect Function ─────────────────────────────────────────────────────────
async function disconnect() {
  try {
    await mongoose.connection.close();
    connectionState.isConnected = false;
    logger.info('[MongoDB] Disconnected gracefully');
  } catch (error) {
    logger.error('[MongoDB] Error during disconnect', { error: error.message });
    throw error;
  }
}

// ── Health Check ────────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    if (!mongoose.connection.db) {
      return { status: 'disconnected', healthy: false };
    }
    await mongoose.connection.db.admin().ping();
    return {
      status: 'connected',
      healthy: true,
      poolSize: POOL_CONFIG.maxPoolSize,
      reconnectAttempts: connectionState.reconnectAttempts,
    };
  } catch (error) {
    return {
      status: 'error',
      healthy: false,
      error: error.message,
    };
  }
}

// ── Get Connection State ────────────────────────────────────────────────────────
function getConnectionState() {
  return { ...connectionState };
}

// ── Exports ─────────────────────────────────────────────────────────────────────
module.exports = {
  connect,
  disconnect,
  healthCheck,
  getConnectionState,
  POOL_CONFIG,
  RETRY_CONFIG,
  STARTUP_RETRY_CONFIG,
  TRANSACTION_CONFIG,
  connectWithRetry,
  isTransientConnectionError,
};
