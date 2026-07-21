/**
 * Concurrent Request Handling Middleware
 * 
 * Express middleware for handling high-traffic concurrent requests with:
 * - Request deduplication using idempotency keys
 * - Rate limiting per client/resource
 * - Request queuing for high-load scenarios
 * - Circuit breaker pattern for fault tolerance
 * - Request timeout handling
 */

'use strict';

const { logger } = require('../utils/logger');
const { getRedisClient, resetRedisClient } = require('../config/redisClient');

// Redis client is centralized in backend/src/config/redisClient.js. If Redis is
// unavailable we fall back to the local in-memory rate limiter.

// ── Circuit Breaker States ─────────────────────────────────────────────────────
const CIRCUIT_STATES = {
  CLOSED: 'closed',      // Normal operation
  OPEN: 'open',          // Failing, reject requests
  HALF_OPEN: 'half_open', // Testing if service recovered
};

// ── Circuit Breaker Class ──────────────────────────────────────────────────────
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold || 2;
    
    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
  }

  /**
   * Execute with circuit breaker protection
   */
  async execute(operation) {
    if (this.state === CIRCUIT_STATES.OPEN) {
      // Check if we should transition to half-open
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      
      if (timeSinceFailure >= this.resetTimeoutMs) {
        this.state = CIRCUIT_STATES.HALF_OPEN;
        this.halfOpenAttempts = 0;
        logger.info('[CircuitBreaker] Transitioning to HALF_OPEN');
      } else {
        throw new Error('Circuit breaker is OPEN - service unavailable');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Record successful operation
   */
  onSuccess() {
    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.successCount++;
      
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.state = CIRCUIT_STATES.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        logger.info('[CircuitBreaker] Circuit CLOSED - service recovered');
      }
    } else {
      this.failureCount = 0;
    }
  }

  /**
   * Record failed operation
   */
  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.state = CIRCUIT_STATES.OPEN;
      logger.warn('[CircuitBreaker] Circuit OPENED - too many failures in half-open state');
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = CIRCUIT_STATES.OPEN;
      logger.warn('[CircuitBreaker] Circuit OPENED - failure threshold reached', {
        failureCount: this.failureCount,
      });
    }
  }

  /**
   * Get current circuit state
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// ── Request Queue ───────────────────────────────────────────────────────────────
class RequestQueue {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 1000;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 30000;
    this.queue = [];
    this.processing = 0;
    this.maxConcurrent = options.maxConcurrent || 50;
  }

  /**
   * Add request to queue
   */
  async enqueue(operation, priority = 0, timeoutMs = this.defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      const queueItem = {
        operation,
        priority,
        timeoutMs,
        resolve,
        reject,
        addedAt: Date.now(),
      };

      // Check queue size
      if (this.queue.length >= this.maxSize) {
        reject(new Error('Request queue is full'));
        return;
      }

      // Insert based on priority (higher priority first)
      const insertIndex = this.queue.findIndex(item => item.priority < priority);
      if (insertIndex === -1) {
        this.queue.push(queueItem);
      } else {
        this.queue.splice(insertIndex, 0, queueItem);
      }

      this.processQueue();

      // Set timeout
      setTimeout(() => {
        const index = this.queue.indexOf(queueItem);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new Error('Request timeout'));
        }
      }, timeoutMs);
    });
  }

  /**
   * Process queue items
   */
  async processQueue() {
    while (this.processing < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      this.processing++;

      item.operation()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.processing--;
          this.processQueue();
        });
    }
  }

  /**
   * Get queue stats
   */
  getStats() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

// ── Request Deduplicator ───────────────────────────────────────────────────────
class RequestDeduplicator {
  constructor(ttlMs = 60000) {
    this.pendingRequests = new Map();
    this.ttlMs = ttlMs;
  }

  /**
   * Check if request is duplicate and mark as pending
   */
  tryStart(key) {
    if (this.pendingRequests.has(key)) {
      return {
        duplicate: true,
        promise: this.pendingRequests.get(key),
      };
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pendingRequests.set(key, { promise, resolve, reject });

    // Auto-cleanup after TTL
    setTimeout(() => {
      if (this.pendingRequests.has(key)) {
        this.pendingRequests.delete(key);
      }
    }, this.ttlMs);

    return { duplicate: false };
  }

  /**
   * Complete a pending request
   */
  complete(key, result, error = null) {
    const pending = this.pendingRequests.get(key);
    if (pending) {
      if (error) {
        pending.reject(error);
      } else {
        pending.resolve(result);
      }
      this.pendingRequests.delete(key);
    }
  }

  /**
   * Get deduplicator stats
   */
  getStats() {
    return {
      pendingCount: this.pendingRequests.size,
    };
  }
}

// ── In-memory rate-limit helper ────────────────────────────────────────────────
function _inMemoryIncrement(store, key, now, windowStart) {
  let entry = store.get(key);
  if (!entry || entry.windowStart < windowStart) {
    entry = { windowStart: now, count: 0 };
  }
  entry.count++;
  store.set(key, entry);
  return entry.count;
}

// ── Middleware Factory ──────────────────────────────────────────────────────────
function createConcurrentRequestMiddleware(options = {}) {
  const circuitBreaker = new CircuitBreaker(options.circuitBreaker || {});
  const requestQueue = new RequestQueue(options.queue || {});
  const deduplicator = new RequestDeduplicator(options.deduplicationTtlMs || 60000);

  return {
    // ── Circuit Breaker Middleware ────────────────────────────────────────────
    circuitBreaker: (operationName) => {
      return async (req, res, next) => {
        try {
          req.circuitBreaker = circuitBreaker;
          const result = await circuitBreaker.execute(async () => {
            return await operationName(req, res, next);
          });
          
          if (result !== undefined) {
            return result;
          }
          next();
        } catch (error) {
          logger.error('[CircuitBreaker] Operation failed', {
            operation: operationName,
            error: error.message,
            circuitState: circuitBreaker.getState(),
          });

          return res.status(503).json({
            error: 'Service temporarily unavailable',
            code: 'SERVICE_UNAVAILABLE',
            retryAfter: Math.ceil(circuitBreaker.resetTimeoutMs / 1000),
          });
        }
      };
    },

    // ── Rate Limiter Middleware ───────────────────────────────────────────────
    rateLimiter: (getKey) => {
      // In-memory fallback store (used when Redis is unavailable).
      const memoryStore = new Map();
      const windowMs = options.rateLimit?.windowMs || 60000;
      const maxRequests = options.rateLimit?.maxRequests || 100;

      return async (req, res, next) => {
        const key = `rl:${getKey(req)}`;
        const now = Date.now();
        const windowStart = now - windowMs;
        const redis = getRedisClient();

        let count;
        if (redis && redis.status !== 'end') {
          try {
            // Atomic increment + expiry using a Redis pipeline.
            // Key format: "rl:<clientKey>:<window-bucket>" where the bucket
            // is the start of the current window (floored to windowMs).
            const bucket = Math.floor(now / windowMs) * windowMs;
            const redisKey = `${key}:${bucket}`;
            const ttlSec = Math.ceil(windowMs / 1000) + 1;
            const [[, cnt]] = await redis
              .pipeline()
              .incr(redisKey)
              .expire(redisKey, ttlSec)
              .exec();
            count = cnt;
          } catch (err) {
            logger.warn('[RateLimiter] Redis op failed, using in-memory fallback', { error: err.message });
            count = _inMemoryIncrement(memoryStore, key, now, windowStart);
          }
        } else {
          count = _inMemoryIncrement(memoryStore, key, now, windowStart);
        }

        if (count > maxRequests) {
          const retryAfter = Math.ceil(windowMs / 1000);
          res.set('Retry-After', retryAfter);
          return res.status(429).json({
            error: 'Too many requests',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter,
          });
        }

        res.set({
          'X-RateLimit-Limit': maxRequests,
          'X-RateLimit-Remaining': maxRequests - count,
          'X-RateLimit-Reset': Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs) / 1000),
        });

        next();
      };
    },

    // ── Idempotency Middleware ─────────────────────────────────────────────────
    idempotency: (keyExtractor, ttlMs = 60000) => {
      const cache = new Map();

      return async (req, res, next) => {
        const key = keyExtractor(req);
        if (!key) {
          return next();
        }

        const cached = cache.get(key);
        if (cached) {
          if (Date.now() > cached.expiresAt) {
            cache.delete(key);
          } else {
            return res.json({
              ...cached.response,
              idempotent: true,
            });
          }
        }

        // Intercept response to cache it
        const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cache.set(key, {
            response: body,
            expiresAt: Date.now() + ttlMs,
          });
        }
        return originalJson(body);
      };

      next();
      };
    },

    // ── Request Queue Middleware ───────────────────────────────────────────────
    requestQueue: (options = {}) => {
      return async (req, res, next) => {
        const timeoutMs = options.timeoutMs || 30000;
        const priority = options.priorityExtractor?.(req) || 0;

        try {
          await requestQueue.enqueue(async () => {
            return new Promise((resolve) => {
              req.queueDone = resolve;
              next();
            });
          }, priority, timeoutMs);
        } catch (error) {
          return res.status(503).json({
            error: 'Service busy - please retry',
            code: 'QUEUE_FULL',
          });
        }
      };
    },

    // ── Request Deduplication Middleware ───────────────────────────────────────
    deduplicate: (keyExtractor) => {
      return async (req, res, next) => {
        const key = keyExtractor(req);
        if (!key) {
          return next();
        }

        const { duplicate, promise } = deduplicator.tryStart(key);
        
        if (duplicate) {
          try {
            const result = await promise;
            return res.json(result);
          } catch (error) {
            return res.status(500).json({
              error: 'Original request failed',
              code: 'DEDUP_ERROR',
            });
          }
        }

        // Store key for cleanup
        req.dedupKey = key;
        req.dedupComplete = (result, error) => {
          deduplicator.complete(key, result, error);
        };

        next();
      };
    },

    // ── Request Timeout Middleware ─────────────────────────────────────────────
    timeout: (timeoutMs = 30000) => {
      return (req, res, next) => {
        const timeoutId = setTimeout(() => {
          if (!res.headersSent) {
            res.status(408).json({
              error: 'Request timeout',
              code: 'REQUEST_TIMEOUT',
            });
          }
        }, timeoutMs);

        res.on('finish', () => clearTimeout(timeoutId));
        next();
      };
    },

    // ── Health Check Endpoint ─────────────────────────────────────────────────
    healthCheck: async (req, res) => {
      res.json({
        status: 'healthy',
        circuitBreaker: circuitBreaker.getState(),
        queue: requestQueue.getStats(),
        deduplicator: deduplicator.getStats(),
      });
    },
  };
}

// ── Express Route Handlers for Concurrent Requests ─────────────────────────────
function createConcurrentPaymentRoutes(paymentProcessor) {
  const express = require('express');
  const router = express.Router();
  const middleware = createConcurrentRequestMiddleware({
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
    queue: { maxConcurrent: 50, maxSize: 1000 },
    rateLimit: { windowMs: 60000, maxRequests: 100 },
  });

  // Apply common middleware
  const rateLimitMiddleware = middleware.rateLimiter((req) => req.ip);
  const timeoutMiddleware = middleware.timeout(30000);

  /**
   * POST /api/payments/process
   * Process a single payment with full concurrency protection
   */
  router.post('/process', 
    rateLimitMiddleware,
    timeoutMiddleware,
    middleware.idempotency((req) => req.headers['idempotency-key']),
    middleware.circuitBreaker(async (req, res) => {
      const { studentId, amount, txHash, memo, senderAddress } = req.body;

      if (!studentId || !amount || !txHash) {
        return res.status(400).json({
          error: 'Missing required fields',
          code: 'VALIDATION_ERROR',
          required: ['studentId', 'amount', 'txHash'],
        });
      }

      const result = await paymentProcessor.processPayment(
        { memo, senderAddress },
        {
          idempotencyKey: req.headers['idempotency-key'],
          studentId,
          amount: parseFloat(amount),
          txHash,
          lockStrategy: req.body.lockStrategy || 'optimistic',
        }
      );

      return res.status(result.success ? 200 : 500).json(result.toJSON());
    })
  );

  /**
   * POST /api/payments/batch
   * Process multiple payments with concurrency control
   */
  router.post('/batch',
    rateLimitMiddleware,
    timeoutMiddleware,
    middleware.idempotency((req) => req.headers['idempotency-key']),
    middleware.circuitBreaker(async (req, res) => {
      const { payments } = req.body;

      if (!Array.isArray(payments) || payments.length === 0) {
        return res.status(400).json({
          error: 'Invalid request body',
          code: 'VALIDATION_ERROR',
        });
      }

      const result = await paymentProcessor.processBatch(payments, {
        concurrencyLimit: parseInt(req.body.concurrencyLimit) || 10,
      });

      return res.json(result);
    })
  );

  /**
   * GET /api/payments/stats
   * Get processor statistics
   */
  router.get('/stats', async (req, res) => {
    res.json(paymentProcessor.getStats());
  });

  /**
   * GET /api/payments/health
   * Health check endpoint
   */
  router.get('/health', middleware.healthCheck);

  return router;
}

module.exports = {
  createConcurrentRequestMiddleware,
  createConcurrentPaymentRoutes,
  CircuitBreaker,
  RequestQueue,
  RequestDeduplicator,
  // exported for testing
  _inMemoryIncrement,
  _getRedisClient: getRedisClient,
  _resetRedisClient: () => { resetRedisClient(); },
};
