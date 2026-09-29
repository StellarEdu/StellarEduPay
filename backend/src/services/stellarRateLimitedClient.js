'use strict';

/**
 * Rate-Limited Stellar API Client
 *
 * A production-ready Stellar API client with:
 * - Request throttling using Bottleneck
 * - Distributed rate limit state via Redis (ioredis) when REDIS_HOST is set,
 *   so all horizontally-scaled Node.js processes share a single counter and
 *   the combined request rate never exceeds Horizon's actual limit.
 * - Automatic in-memory fallback when Redis is unavailable (single-instance mode)
 * - Queue system for outgoing requests
 * - Retry mechanism with exponential backoff
 * - Graceful handling of HTTP 429 (rate limit) errors
 * - Configurable rate limits via environment variables
 * - Comprehensive logging for request flow
 *
 * Multi-instance note:
 *   Set REDIS_HOST (and optionally REDIS_PORT / REDIS_PASSWORD) to enable
 *   distributed rate limiting.  Without Redis every process maintains its own
 *   independent counter, which can cause the combined rate to exceed Horizon's
 *   limit when running more than one instance.
 *
 * @author StellarEduPay Team
 * @version 2.0.0
 */

const Bottleneck = require('bottleneck');
const { Server, Networks, Asset, Keypair, TransactionBuilder, Operation } = require('@stellar/stellar-sdk');
const config = require('../config');
const logger = require('../utils/logger');
const { getRedisClient, getRedisStatus } = require('../config/redisClient');

// Redis connection is optional – only required for distributed mode.
let IORedisConnection;
try {
  // Bottleneck ships its own IORedisConnection wrapper that accepts an ioredis client.
  IORedisConnection = require('bottleneck/lib/IORedisConnection.js');
} catch (_) {
  // Older Bottleneck builds expose it differently; fall back gracefully.
  IORedisConnection = null;
}

/**
 * Build an ioredis client from environment variables.
 * Returns null when REDIS_HOST is not configured.
 */
function _createRedisClient() {
  if (!process.env.REDIS_HOST) return null;

  try {
    const client = getRedisClient();
    if (!client) {
      logger.warn('[StellarRateLimitedClient] Redis is configured but unavailable; using in-memory limiter');
      return null;
    }

    if (client.status !== 'ready') {
      client.on('error', (err) => {
        logger.warn('[StellarRateLimitedClient] Redis error – falling back to in-memory limiter:', err.message);
      });
    }

    return client;
  } catch (err) {
    logger.warn('[StellarRateLimitedClient] Could not obtain centralized Redis client:', err.message);
    return null;
  }
}

/**
 * Rate Limit Configuration
 * These can be overridden via environment variables
 */
const RATE_LIMIT_CONFIG = {
  // Bottleneck settings
  MIN_TIME: parseInt(process.env.STELLAR_RATE_LIMIT_MIN_TIME) || 50,        // Min time between requests (ms)
  MAX_CONCURRENT: parseInt(process.env.STELLAR_RATE_LIMIT_MAX_CONCURRENT) || 10, // Max concurrent requests
  HIGH_WATER: parseInt(process.env.STELLAR_RATE_LIMIT_HIGH_WATER) || 100,    // Queue high water mark
  STRATEGY: process.env.STELLAR_RATE_LIMIT_STRATEGY || Bottleneck.strategy.LEAK, // Queue strategy
  
  // Retry configuration
  RETRY_MAX_ATTEMPTS: parseInt(process.env.STELLAR_RETRY_MAX_ATTEMPTS) || 5,
  RETRY_INITIAL_DELAY: parseInt(process.env.STELLAR_RETRY_INITIAL_DELAY) || 1000, // Initial delay (ms)
  RETRY_MAX_DELAY: parseInt(process.env.STELLAR_RETRY_MAX_DELAY) || 30000,   // Max delay (ms)
  RETRY_FACTOR: parseFloat(process.env.STELLAR_RETRY_FACTOR) || 2,           // Exponential backoff factor
  
  // Rate limit headers (Stellar Horizon)
  HORIZON_RATE_LIMIT: parseInt(process.env.HORIZON_RATE_LIMIT_HEADER) || 3600, // Requests per hour
  HORIZON_RATE_LIMIT_WINDOW: parseInt(process.env.HORIZON_RATE_LIMIT_WINDOW_MS) || 3600000, // Window in ms
  
  // Burst protection
  BURST_ALLOWANCE: parseInt(process.env.STELLAR_BURST_ALLOWANCE) || 20,     // Max burst size
  BURST_WINDOW: parseInt(process.env.STELLAR_BURST_WINDOW) || 1000,         // Burst window (ms)
};

/**
 * Error types for better error handling
 */
const ERROR_TYPES = {
  RATE_LIMIT: 'RATE_LIMIT_ERROR',
  TIMEOUT: 'TIMEOUT_ERROR',
  NETWORK: 'NETWORK_ERROR',
  SERVER: 'SERVER_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
};

/**
 * Custom error class for Stellar API errors
 */
class StellarAPIError extends Error {
  constructor(message, type, statusCode, originalError = null) {
    super(message);
    this.name = 'StellarAPIError';
    this.type = type;
    this.statusCode = statusCode;
    this.originalError = originalError;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * In-memory queue for request tracking and burst protection
 */
class RequestQueue {
  constructor(options = {}) {
    this.maxSize = options.maxSize || RATE_LIMIT_CONFIG.HIGH_WATER;
    this.queue = [];
    this.processing = new Set();
    this.completed = 0;
    this.failed = 0;
    this.rejected = 0;
    
    // Burst tracking
    this.burstTracker = [];
    this.burstWindow = options.burstWindow || RATE_LIMIT_CONFIG.BURST_WINDOW;
    this.burstAllowance = options.burstAllowance || RATE_LIMIT_CONFIG.BURST_ALLOWANCE;
    
    logger.info('[RequestQueue] Initialized with max size:', this.maxSize);
  }

  /**
   * Check if burst allowance is exceeded
   */
  canBurst() {
    const now = Date.now();
    this.burstTracker = this.burstTracker.filter(t => now - t < this.burstWindow);
    return this.burstTracker.length < this.burstAllowance;
  }

  /**
   * Record a burst request
   */
  recordBurst() {
    this.burstTracker.push(Date.now());
  }

  /**
   * Add request to queue
   */
  enqueue(requestId, priority = 0) {
    if (this.queue.length >= this.maxSize) {
      this.rejected++;
      throw new StellarAPIError(
        `Queue is full (${this.maxSize} requests). Try again later.`,
        ERROR_TYPES.RATE_LIMIT,
        429
      );
    }
    
    const entry = {
      id: requestId,
      priority,
      enqueuedAt: Date.now(),
    };
    
    // Insert based on priority (higher priority first)
    const insertIndex = this.queue.findIndex(e => e.priority < priority);
    if (insertIndex === -1) {
      this.queue.push(entry);
    } else {
      this.queue.splice(insertIndex, 0, entry);
    }
    
    logger.debug(`[RequestQueue] Enqueued request ${requestId} (position: ${insertIndex + 1}/${this.queue.length})`);
    return entry;
  }

  /**
   * Get next request from queue
   */
  dequeue() {
    return this.queue.shift();
  }

  /**
   * Remove specific request from queue
   */
  remove(requestId) {
    const index = this.queue.findIndex(e => e.id === requestId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      queued: this.queue.length,
      processing: this.processing.size,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
      utilization: ((this.processing.size / RATE_LIMIT_CONFIG.MAX_CONCURRENT) * 100).toFixed(2) + '%',
      burstAvailable: this.burstAllowance - this.burstTracker.filter(t => Date.now() - t < this.burstWindow).length,
    };
  }

  /**
   * Clear completed tracking
   */
  reset() {
    this.completed = 0;
    this.failed = 0;
    this.rejected = 0;
  }
}

/**
 * Main Rate-Limited Stellar Client
 */
class StellarRateLimitedClient {
  constructor(options = {}) {
    // Initialize configuration
    this.config = {
      horizonUrl: options.horizonUrl || config.HORIZON_URL,
      networkPassphrase: options.networkPassphrase || (
        config.IS_TESTNET ? Networks.TESTNET : Networks.PUBLIC
      ),
      ...RATE_LIMIT_CONFIG,
    };

    // Initialize SDK server
    this.server = new Server(this.config.horizonUrl);

    // Initialize request queue
    this.requestQueue = new RequestQueue({
      maxSize: options.maxQueueSize || RATE_LIMIT_CONFIG.HIGH_WATER,
      burstWindow: RATE_LIMIT_CONFIG.BURST_WINDOW,
      burstAllowance: RATE_LIMIT_CONFIG.BURST_ALLOWANCE,
    });

    // ── Distributed rate limiting via Redis ──────────────────────────────
    // When REDIS_HOST is configured we share the Bottleneck state across all
    // Node.js processes/containers so the combined request rate never exceeds
    // Horizon's actual limit.  Without Redis each process is independent
    // (single-instance / development mode).
    this._redisClient = options.redisClient !== undefined
      ? options.redisClient   // allow injection for tests
      : _createRedisClient();

    this._usingRedis = false;

    const bottleneckOpts = {
      minTime: this.config.MIN_TIME,
      maxConcurrent: this.config.MAX_CONCURRENT,
      highWater: this.config.HIGH_WATER,
      strategy: this.config.STRATEGY,
    };

    if (this._redisClient && IORedisConnection) {
      try {
        // Shared datastore key so all instances coordinate on the same bucket.
        const datastoreId = options.datastoreId || 'stellar-rate-limiter';
        this.limiter = new Bottleneck({
          ...bottleneckOpts,
          id: datastoreId,
          datastore: 'ioredis',
          clearDatastore: false,
          clientOptions: {},   // unused when connection is provided directly
          // Bottleneck accepts a pre-built IORedisConnection
          connection: new IORedisConnection({ client: this._redisClient }),
        });
        this._usingRedis = true;
        logger.info('[StellarRateLimitedClient] Using Redis-backed distributed rate limiter (id: ' + datastoreId + ')');
      } catch (err) {
        logger.warn('[StellarRateLimitedClient] Failed to init Redis limiter, falling back to in-memory:', err.message);
        this.limiter = new Bottleneck(bottleneckOpts);
      }
    } else {
      if (process.env.REDIS_HOST) {
        logger.warn('[StellarRateLimitedClient] REDIS_HOST is set but IORedisConnection is unavailable – using in-memory limiter. Rate limit state will NOT be shared across processes.');
      } else {
        logger.info('[StellarRateLimitedClient] No REDIS_HOST configured – using in-memory rate limiter (single-instance mode).');
      }
      this.limiter = new Bottleneck(bottleneckOpts);
    }

    // Setup Bottleneck events
    this._setupLimiterEvents();

    // Track rate limit status
    this.rateLimitStatus = {
      remaining: this.config.HORIZON_RATE_LIMIT,
      resetAt: Date.now() + this.config.HORIZON_RATE_LIMIT_WINDOW,
      lastUpdated: Date.now(),
      distributed: this._usingRedis,
    };

    // Statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retriedRequests: 0,
      rateLimitedRequests: 0,
    };

    logger.info('[StellarRateLimitedClient] Initialized with config:', {
      horizonUrl: this.config.horizonUrl,
      minTime: this.config.MIN_TIME,
      maxConcurrent: this.config.MAX_CONCURRENT,
      retryMaxAttempts: this.config.RETRY_MAX_ATTEMPTS,
      distributedMode: this._usingRedis,
    });
  }

  /**
   * Setup Bottleneck event handlers
   */
  _setupLimiterEvents() {
    this.limiter.on('debug', (method, ...args) => {
      logger.debug(`[Bottleneck] ${method}:`, ...args);
    });
    
    this.limiter.on('dropped', (dropped) => {
      logger.warn('[Bottleneck] Request dropped:', dropped);
      this.requestQueue.rejected++;
    });
    
    this.limiter.on('empty', () => {
      logger.debug('[Bottleneck] Queue is now empty');
    });
    
    this.limiter.on('done', () => {
      this._updateRateLimitStatus();
    });
  }

  /**
   * Update rate limit status from Horizon headers
   */
  _updateRateLimitStatus(response = null) {
    if (response && response.headers) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      
      if (remaining !== null) {
        this.rateLimitStatus.remaining = parseInt(remaining);
        this.rateLimitStatus.lastUpdated = Date.now();
      }
      
      if (reset !== null) {
        this.rateLimitStatus.resetAt = parseInt(reset) * 1000; // Convert to ms
      }
    }
  }

  /**
   * Calculate exponential backoff delay
   */
  _calculateBackoff(attempt) {
    const delay = Math.min(
      this.config.RETRY_INITIAL_DELAY * Math.pow(this.config.RETRY_FACTOR, attempt),
      this.config.RETRY_MAX_DELAY
    );
    
    // Add jitter to prevent thundering herd
    const jitter = delay * 0.1 * Math.random();
    return Math.floor(delay + jitter);
  }

  /**
   * Check if error is retryable
   */
  _isRetryableError(error) {
    // HTTP 429 (Rate Limited) is always retryable
    if (error.statusCode === 429) return true;
    
    // Network errors are retryable
    if (error.type === ERROR_TYPES.NETWORK || error.type === ERROR_TYPES.TIMEOUT) return true;
    
    // Server errors (5xx) are retryable
    if (error.statusCode >= 500 && error.statusCode < 600) return true;
    
    return false;
  }

  /**
   * Sleep utility for async delays
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate unique request ID
   */
  _generateRequestId() {
    return `stellar_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Wrap API call with rate limiting, retry logic, and queue management
   */
  async _executeWithLimits(requestFn, options = {}) {
    const requestId = options.requestId || this._generateRequestId();
    const priority = options.priority || 0;
    const startTime = Date.now();
    
    // Check burst allowance
    if (!this.requestQueue.canBurst() && priority < 10) {
      logger.warn(`[${requestId}] Burst limit reached, request queued`);
    }
    this.requestQueue.recordBurst();
    
    // Enqueue request
    this.requestQueue.enqueue(requestId, priority);
    
    logger.info(`[${requestId}] Request queued (priority: ${priority})`);
    
    try {
      // Execute through Bottleneck
      const result = await this.limiter.schedule(
        { id: requestId, priority },
        async () => {
          logger.debug(`[${requestId}] Executing request`);
          
          try {
            const response = await requestFn();
            this._updateRateLimitStatus(response);
            
            logger.info(`[${requestId}] Request completed successfully (${Date.now() - startTime}ms)`);
            this.requestQueue.completed++;
            this.stats.successfulRequests++;
            
            return response;
          } catch (error) {
            throw this._normalizeError(error, requestId);
          }
        }
      );
      
      this.stats.totalRequests++;
      return result;
      
    } catch (error) {
      return this._handleError(error, requestFn, options, startTime);
    }
  }

  /**
   * Handle errors with retry logic
   */
  async _handleError(error, requestFn, options, startTime) {
    const requestId = options.requestId || this._generateRequestId();
    const attempt = options.attempt || 0;
    
    logger.warn(`[${requestId}] Request failed (attempt ${attempt + 1}):`, error.message);
    
    // Check if we should retry
    if (attempt < this.config.RETRY_MAX_ATTEMPTS - 1 && this._isRetryableError(error)) {
      const delay = this._calculateBackoff(attempt);
      
      logger.info(`[${requestId}] Retrying in ${delay}ms (attempt ${attempt + 2}/${this.config.RETRY_MAX_ATTEMPTS})`);
      
      this.stats.retriedRequests++;
      
      // Wait before retry
      await this._sleep(delay);
      
      // Retry with incremented attempt
      return this._executeWithLimits(requestFn, {
        ...options,
        attempt: attempt + 1,
        requestId,
      });
    }
    
    // Max retries exceeded or non-retryable error
    this.requestQueue.failed++;
    this.stats.failedRequests++;
    this.stats.totalRequests++;
    
    logger.error(`[${requestId}] Request failed after ${attempt + 1} attempts:`, error.message);
    
    throw error;
  }

  /**
   * Normalize different error types to StellarAPIError
   */
  _normalizeError(error, requestId) {
    // Already a StellarAPIError
    if (error instanceof StellarAPIError) return error;
    
    // Extract status code from various error formats
    let statusCode = 500;
    let type = ERROR_TYPES.SERVER;
    
    if (error.response) {
      // Axios-style error
      statusCode = error.response.status;
    } else if (error.statusCode) {
      // Direct status code
      statusCode = error.statusCode;
    } else if (error.status) {
      // Alternative status field
      statusCode = error.status;
    }
    
    // Determine error type
    if (statusCode === 429) {
      type = ERROR_TYPES.RATE_LIMIT;
      this.stats.rateLimitedRequests++;
    } else if (statusCode === 408 || error.code === 'ETIMEDOUT') {
      type = ERROR_TYPES.TIMEOUT;
    } else if (statusCode >= 500) {
      type = ERROR_TYPES.SERVER;
    } else if (statusCode >= 400) {
      type = ERROR_TYPES.VALIDATION;
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      type = ERROR_TYPES.NETWORK;
    }
    
    const stellarError = new StellarAPIError(
      error.message || 'Unknown Stellar API error',
      type,
      statusCode,
      error
    );
    
    stellarError.requestId = requestId;
    return stellarError;
  }

  // ==================== PUBLIC API METHODS ====================
  
  /**
   * Get account information with rate limiting
   */
  async getAccount(publicKey, options = {}) {
    return this._executeWithLimits(async () => {
      return await this.server.loadAccount(publicKey);
    }, {
      priority: options.priority || 5,
      ...options,
    });
  }

  /**
   * Get account balances with rate limiting
   */
  async getAccountBalances(publicKey, options = {}) {
    const account = await this.getAccount(publicKey, options);
    return account.balances;
  }

  /**
   * Get transaction by hash with rate limiting
   */
  async getTransaction(txHash, options = {}) {
    return this._executeWithLimits(async () => {
      return await this.server.transactions().transaction(txHash).call();
    }, {
      priority: options.priority || 5,
      ...options,
    });
  }

  /**
   * Get transactions for account with rate limiting
   */
  async getTransactionsForAccount(publicKey, options = {}) {
    const { limit = 20, order = 'desc', ...queryOptions } = options;
    
    return this._executeWithLimits(async () => {
      return await this.server
        .transactions()
        .forAccount(publicKey)
        .order(order)
        .limit(limit)
        .call();
    }, {
      priority: options.priority || 5,
      ...queryOptions,
    });
  }

  /**
   * Get ledger information with rate limiting
   */
  async getLedger(sequence, options = {}) {
    return this._executeWithLimits(async () => {
      return await this.server.ledgers().ledger(sequence).call();
    }, {
      priority: options.priority || 3,
      ...options,
    });
  }

  /**
   * Get latest ledger with rate limiting
   */
  async getLatestLedger(options = {}) {
    return this._executeWithLimits(async () => {
      const ledgers = await this.server.ledgers().order('desc').limit(1).call();
      return ledgers.records[0];
    }, {
      priority: options.priority || 3,
      ...options,
    });
  }

  /**
   * Get offers for an account with rate limiting
   */
  async getOffers(publicKey, options = {}) {
    return this._executeWithLimits(async () => {
      return await this.server.offers('accounts', publicKey).call();
    }, {
      priority: options.priority || 4,
      ...options,
    });
  }

  /**
   * Get trade effects for an account with rate limiting
   */
  async getTrades(publicKey, options = {}) {
    const { limit = 20, ...queryOptions } = options;
    
    return this._executeWithLimits(async () => {
      return await this.server
        .trades()
        .forAccount(publicKey)
        .limit(limit)
        .call();
    }, {
      priority: options.priority || 4,
      ...queryOptions,
    });
  }

  /**
   * Submit transaction with rate limiting and enhanced retry
   * Higher priority and more retries for transaction submissions
   */
  async submitTransaction(envelope, options = {}) {
    const submitOptions = {
      ...options,
      priority: options.priority || 8, // Higher priority for transactions
      attempt: 0,
    };
    
    let lastError;
    
    for (let attempt = 0; attempt < this.config.RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._executeWithLimits(async () => {
          const response = await this.server.submitTransaction(envelope);
          logger.info(`[Transaction] Submitted successfully: ${response.hash}`);
          return response;
        }, submitOptions);
      } catch (error) {
        lastError = error;
        
        // Don't retry if it's a validation error
        if (error.type === ERROR_TYPES.VALIDATION) {
          throw error;
        }
        
        if (attempt < this.config.RETRY_MAX_ATTEMPTS - 1) {
          const delay = this._calculateBackoff(attempt);
          logger.warn(`[Transaction] Submission failed, retrying in ${delay}ms (attempt ${attempt + 2}/${this.config.RETRY_MAX_ATTEMPTS})`);
          await this._sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Stream account payments with rate limiting consideration
   * Note: Streaming doesn't go through the rate limiter
   */
  streamPayments(publicKey, callback, options = {}) {
    logger.info(`[Stream] Starting payment stream for ${publicKey}`);
    
    const handlePayment = (payment) => {
      logger.debug(`[Stream] Received payment for ${publicKey}`);
      callback(payment);
    };
    
    const handleError = (error) => {
      logger.error(`[Stream] Error in payment stream:`, error.message);
      if (options.onError) {
        options.onError(error);
      }
    };
    
    const handleClose = () => {
      logger.info(`[Stream] Payment stream closed for ${publicKey}`);
      if (options.onClose) {
        options.onClose();
      }
    };
    
    return this.server.payments()
      .forAccount(publicKey)
      .cursor(options.cursor || 'now')
      .stream({
        onmessage: handlePayment,
        onerror: handleError,
        onclose: handleClose,
      });
  }

  /**
   * Stream transactions for an account
   */
  streamTransactions(publicKey, callback, options = {}) {
    logger.info(`[Stream] Starting transaction stream for ${publicKey}`);
    
    return this.server.transactions()
      .forAccount(publicKey)
      .cursor(options.cursor || 'now')
      .stream({
        onmessage: (tx) => {
          logger.debug(`[Stream] Received transaction for ${publicKey}`);
          callback(tx);
        },
        onerror: (error) => {
          logger.error(`[Stream] Error in transaction stream:`, error.message);
          if (options.onError) {
            options.onError(error);
          }
        },
        onclose: () => {
          logger.info(`[Stream] Transaction stream closed for ${publicKey}`);
          if (options.onClose) {
            options.onClose();
          }
        },
      });
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get client statistics
   */
  getStats() {
    return {
      ...this.stats,
      queue: this.requestQueue.getStats(),
      rateLimit: this.rateLimitStatus,
      distributed: this._usingRedis,
      limiter: {
        queued: this.limiter.queued(),
        running: this.limiter.running(),
        done: this.limiter.done(),
      },
    };
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus() {
    return { ...this.rateLimitStatus };
  }

  /**
   * Check if client is ready (not overloaded)
   */
  isReady() {
    const queueStats = this.requestQueue.getStats();
    return queueStats.queued < RATE_LIMIT_CONFIG.HIGH_WATER * 0.8;
  }

  /**
   * Update rate limits dynamically
   */
  updateLimits(newLimits) {
    logger.info('[StellarRateLimitedClient] Updating limits:', newLimits);
    
    if (newLimits.minTime) {
      this.limiter.updateSettings({ minTime: newLimits.minTime });
      this.config.MIN_TIME = newLimits.minTime;
    }
    
    if (newLimits.maxConcurrent) {
      this.limiter.updateSettings({ maxConcurrent: newLimits.maxConcurrent });
      this.config.MAX_CONCURRENT = newLimits.maxConcurrent;
    }
    
    // Return updated config
    return { ...this.config };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retriedRequests: 0,
      rateLimitedRequests: 0,
    };
    this.requestQueue.reset();
    logger.info('[StellarRateLimitedClient] Statistics reset');
  }

  /**
   * Force disconnect (cleanup)
   */
  async disconnect() {
    logger.info('[StellarRateLimitedClient] Disconnecting...');

    // Stop accepting new requests
    this.limiter.stop();

    // Wait for pending requests
    const timeout = 30000; // 30 seconds
    const startTime = Date.now();

    while (this.limiter.running() > 0 && Date.now() - startTime < timeout) {
      await this._sleep(100);
    }

    logger.info('[StellarRateLimitedClient] Disconnected');
  }
}

// ==================== SINGLETON INSTANCE ====================

let clientInstance = null;

/**
 * Get or create the singleton client instance
 */
function getClient(options = {}) {
  if (!clientInstance) {
    clientInstance = new StellarRateLimitedClient(options);
  }
  return clientInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
function resetClient() {
  if (clientInstance) {
    clientInstance.disconnect();
  }
  clientInstance = null;
}

/**
 * Factory for creating new client instances
 */
function createClient(options = {}) {
  return new StellarRateLimitedClient(options);
}

module.exports = {
  StellarRateLimitedClient,
  StellarAPIError,
  ERROR_TYPES,
  RATE_LIMIT_CONFIG,
  RequestQueue,
  getClient,
  resetClient,
  createClient,
};
