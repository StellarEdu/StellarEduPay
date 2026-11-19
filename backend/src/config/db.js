'use strict';

/**
 * Database-scoped configuration (#1726).
 *
 * database.js reads its connection, pool, retry and transaction settings from
 * this module instead of the global config in ./index.js. That keeps the
 * migration CLI (scripts/migrate.js) independent of the auth and receipt
 * secrets that ./index.js requires at boot.
 *
 * Each value reads its environment variable and falls back to the default the
 * connection layer has always used.
 */

const env = (name, fallback) => process.env[name] || fallback;
const intEnv = (name, fallback) => parseInt(env(name, fallback), 10);

const db = {
  // Connection pool. MONGODB_POOL_SIZE is canonical; DB_MAX_POOL_SIZE is accepted for compatibility.
  maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE || process.env.DB_MAX_POOL_SIZE || '20', 10),
  minPoolSize: intEnv('DB_MIN_POOL_SIZE', '10'),
  maxIdleTimeMS: intEnv('DB_MAX_IDLE_TIME_MS', '30000'),
  connectTimeoutMS: intEnv('DB_CONNECT_TIMEOUT_MS', '10000'),
  socketTimeoutMS: intEnv('DB_SOCKET_TIMEOUT_MS', '45000'),
  serverSelectionTimeoutMS: intEnv('DB_SERVER_SELECTION_TIMEOUT_MS', '5000'),
  maxConcurrent: intEnv('DB_MAX_CONCURRENT', '50'),

  // Server-side ceiling on one report aggregation. socketTimeoutMS only abandons the client socket.
  reportAggregationMaxTimeMS: intEnv('DB_REPORT_AGGREGATION_MAX_TIME_MS', '15000'),

  // Retry policy for transient errors, with exponential backoff.
  maxRetries: intEnv('DB_MAX_RETRIES', '3'),
  initialRetryDelayMs: intEnv('DB_INITIAL_RETRY_DELAY_MS', '100'),
  maxRetryDelayMs: intEnv('DB_MAX_RETRY_DELAY_MS', '5000'),

  // Startup connection retries.
  connectRetries: intEnv('MONGODB_CONNECT_RETRIES', '5'),
  connectDelayMs: intEnv('MONGODB_CONNECT_DELAY_MS', '2000'),

  // Transaction durability and limits.
  readConcern: env('DB_READ_CONCERN', 'majority'),
  writeConcern: intEnv('DB_WRITE_CONCERN', '1'),
  journal: process.env.DB_JOURNAL === 'true',
  transactionTimeoutMs: intEnv('DB_TRANSACTION_TIMEOUT_MS', '30000'),
};

module.exports = { db };
