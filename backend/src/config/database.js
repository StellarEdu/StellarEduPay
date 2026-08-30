/**
 * Database Configuration with Connection Pooling
 * 
 * Production-ready MongoDB connection settings optimized for high-traffic
 * financial transaction processing with proper concurrency handling.
 */

'use strict';

const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

// ── Connection Pool Configuration ──────────────────────────────────────────────
const POOL_CONFIG = {
  // Maximum number of sockets in the connection pool.
  // MONGODB_POOL_SIZE is the canonical env var (default: 20).
  // DB_MAX_POOL_SIZE is also accepted for backward compatibility.
  maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE || process.env.DB_MAX_POOL_SIZE || '20', 10),
  
  // Minimum number of sockets in the connection pool
  minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '10', 10),
  
  // Maximum time in milliseconds a socket can remain idle
  maxIdleTimeMS: parseInt(process.env.DB_MAX_IDLE_TIME_MS || '30000', 10),
  
  // Connection timeout in milliseconds
  connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  
  // Socket timeout in milliseconds (default: 45000)
  socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS || '45000', 10),

  // Server selection timeout in milliseconds (default: 5000)
  serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
  
  // Maximum number of concurrent operations
  maxConcurrent: parseInt(process.env.DB_MAX_CONCURRENT || '50', 10),

  // Server-side ceiling on a single report aggregation, in milliseconds
  // (default: 15000). socketTimeoutMS only abandons the client's socket — the
  // server keeps executing the pipeline and keeps holding its connection.
  // maxTimeMS is what actually makes the server stop, so a slow report cannot
  // pin a pool connection for the length of the query.
  reportAggregationMaxTimeMS: parseInt(
    process.env.DB_REPORT_AGGREGATION_MAX_TIME_MS || '15000',
    10
  ),
};

// ── Retry Configuration ─────────────────────────────────────────────────────────
const RETRY_CONFIG = {
  // Maximum number of retry attempts for transient errors
  maxRetries: parseInt(process.env.DB_MAX_RETRIES || '3', 10),
  
  // Initial retry delay in milliseconds (exponential backoff)
  initialRetryDelayMs: parseInt(process.env.DB_INITIAL_RETRY_DELAY_MS || '100', 10),
  
  // Maximum retry delay in milliseconds
  maxRetryDelayMs: parseInt(process.env.DB_MAX_RETRY_DELAY_MS || '5000', 10),
};

// ── Startup Connection Retry Configuration ──────────────────────────────────────
const STARTUP_RETRY_CONFIG = {
  // Maximum number of retry attempts on startup (default: 5)
  maxRetries: parseInt(process.env.MONGODB_CONNECT_RETRIES || '5', 10),
  
  // Initial retry delay in milliseconds (default: 2000)
  initialDelayMs: parseInt(process.env.MONGODB_CONNECT_DELAY_MS || '2000', 10),
};

// ── Transaction Configuration ───────────────────────────────────────────────────
const TRANSACTION_CONFIG = {
  // Read concern level for transactions
  readConcern: process.env.DB_READ_CONCERN || 'majority',
  
  // Write concern level for transactions
  writeConcern: parseInt(process.env.DB_WRITE_CONCERN || '1', 10),
  
  // Journal sync mode
  journal: process.env.DB_JOURNAL === 'true',
  
  // Transaction timeout in milliseconds
  transactionTimeoutMs: parseInt(process.env.DB_TRANSACTION_TIMEOUT_MS || '30000', 10),
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
  const MONGO_URI = process.env.MONGO_URI;
  
  if (!MONGO_URI) {
    throw new Error('MONGO_URI environment variable is required');
  }

  // Set up event handlers
  setupConnectionEventHandlers();

  // Connection options
  const options = {
    // Use replica set for transactions (required in MongoDB 4.2+)
    useNewUrlParser: true,
    useUnifiedTopology: true,
  };

  logger.info('[MongoDB] Initiating connection', {
    uri: MONGO_URI.replace(/\/\/.*@/, '//<credentials>@'), // Hide credentials
    poolConfig: POOL_CONFIG,
    startupRetries: STARTUP_RETRY_CONFIG.maxRetries,
    startupRetryDelayMs: STARTUP_RETRY_CONFIG.initialDelayMs,
  });

  return connectWithStartupRetry(MONGO_URI, options);
}

// ── Connect with Startup Retry Logic ────────────────────────────────────────────
async function connectWithStartupRetry(uri, options = {}, retryCount = 0) {
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
    logger.info('[MongoDB] Connected successfully on startup', {
      attempt: retryCount + 1,
      totalAttempts: STARTUP_RETRY_CONFIG.maxRetries,
    });
    return mongoose.connection;
  } catch (error) {
    connectionState.isConnecting = false;
    connectionState.reconnectAttempts = retryCount + 1;

    // Check if we should retry
    const isTransientError = isTransientConnectionError(error);
    
    if (isTransientError && retryCount < STARTUP_RETRY_CONFIG.maxRetries - 1) {
      const delay = STARTUP_RETRY_CONFIG.initialDelayMs * Math.pow(2, retryCount);
      logger.warn(`[MongoDB] Connection failed on startup, retrying in ${delay}ms...`, {
        attempt: retryCount + 1,
        maxRetries: STARTUP_RETRY_CONFIG.maxRetries,
        error: error.message,
      });
      
      await sleep(delay);
      return connectWithStartupRetry(uri, options, retryCount + 1);
    }

    logger.error('[MongoDB] Connection failed permanently on startup', {
      attempts: retryCount + 1,
      maxRetries: STARTUP_RETRY_CONFIG.maxRetries,
      error: error.message,
    });
    throw error;
  }
}

// ── Graceful Disconnect ────────────────────────────────────────────────────────
async function disconnect(force = false) {
  try {
    if (mongoose.connection.readyState === 0) {
      logger.info('[MongoDB] Already disconnected');
      return;
    }

    logger.info('[MongoDB] Initiating graceful disconnect', { force });
    
    if (force) {
      await mongoose.connection.close(true);
    } else {
      // Wait for pending operations to complete
      await mongoose.connection.close(false);
    }
    
    connectionState.isConnected = false;
    logger.info('[MongoDB] Disconnected successfully');
  } catch (error) {
    logger.error('[MongoDB] Disconnect error', { error: error.message });
    throw error;
  }
}

// ── Health Check ────────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    const readyState = mongoose.connection.readyState;
    if (readyState !== 1) {
      return { healthy: false, reason: 'Not connected', readyState };
    }

    const start = Date.now();
    await mongoose.connection.db.admin().ping();
    const latency = Date.now() - start;

    return {
      healthy: true,
      latency,
      readyState,
    };
  } catch (error) {
    return { healthy: false, reason: error.message };
  }
}

// ── Get Connection Info ─────────────────────────────────────────────────────────
function getConnectionInfo() {
  return {
    readyState: mongoose.connection.readyState,
    isConnected: connectionState.isConnected,
    isConnecting: connectionState.isConnecting,
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name,
    lastConnectedAt: connectionState.lastConnectedAt,
    reconnectAttempts: connectionState.reconnectAttempts,
    poolConfig: POOL_CONFIG,
  };
}

// ── Get Mongoose Connection ────────────────────────────────────────────────────
function getConnection() {
  return mongoose.connection;
}

// ── Export Configuration ────────────────────────────────────────────────────────
const databaseConfig = {
  connect,
  disconnect,
  healthCheck,
  getConnectionInfo,
  getConnection,
  setupConnectionEventHandlers,
  POOL_CONFIG,
  RETRY_CONFIG,
  STARTUP_RETRY_CONFIG,
  TRANSACTION_CONFIG,
  mongoose,
};

module.exports = databaseConfig;
