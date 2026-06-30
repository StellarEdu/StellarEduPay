/**
 * Retry Queue Setup and Initialization
 * 
 * This module handles the startup and integration of the BullMQ
 * retry queue system with the main application.
 */

const bullMQRetryService = require('../services/bullMQRetryService');
const retryQueueRoutes = require('../routes/retryQueueRoutes');
const logger = require('../utils/logger').child('RetryQueueSetup');

let isInitialized = false;

// Tracks the outcome of the most recent initialization attempt so /health and
// startup assertions can fail loudly when the retry/dead-letter pipeline is dead.
//   status: 'not_started' | 'ok' | 'failed'
let initState = { status: 'not_started', error: null };

/**
 * Initialize the retry queue system
 */
async function initializeRetryQueue(app) {
  if (isInitialized) {
    logger.info('Already initialized');
    return;
  }

  try {
    logger.info('Starting initialization...');

    // Initialize the BullMQ queue system
    await bullMQRetryService.initializeRetryQueue();

    logger.info('BullMQ queue system initialized');

    // Register routes if app is provided
    if (app) {
      app.use('/api/retry-queue', retryQueueRoutes);
      logger.info('Routes registered at /api/retry-queue');
    }

    // Main application manages process signal handling to avoid duplicate shutdown paths.
    setupGracefulShutdown();

    isInitialized = true;
    initState = { status: 'ok', error: null };
    logger.info('Initialization complete');

    return {
      success: true,
      message: 'Retry queue system initialized successfully',
    };

  } catch (error) {
    initState = { status: 'failed', error: error.message };
    logger.error('Initialization failed', { error: error.message });
    throw error;
  }
}

/**
 * Lightweight init status for health checks and startup assertions.
 * Does not touch Redis — reflects the outcome of initializeRetryQueue().
 */
function getRetryQueueHealth() {
  return { ...initState, initialized: isInitialized };
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown() {
  logger.info('Main application manages process shutdown; skipping duplicate signal handlers');
}

/**
 * Graceful shutdown function
 */
async function gracefulShutdown() {
  try {
    logger.info('Starting graceful shutdown...');
    
    // Get final stats before shutdown
    const stats = await bullMQRetryService.getRetryQueueStats();
    logger.info('Final queue stats', { stats });
    
    // Shutdown the queue system
    await bullMQRetryService.shutdownQueue();
    
    logger.info('Graceful shutdown complete');
    
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
  }
}

/**
 * Get system status
 */
async function getSystemStatus() {
  try {
    const health = await bullMQRetryService.getHealthStatus();
    const stats = await bullMQRetryService.getRetryQueueStats();
    
    return {
      initialized: isInitialized,
      health,
      stats,
      timestamp: new Date().toISOString(),
    };
    
  } catch (error) {
    return {
      initialized: isInitialized,
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Setup periodic health checks and monitoring
 */
function setupMonitoring(intervalMs = 60000) {
  logger.info(`Setting up monitoring with ${intervalMs}ms interval`);
  
  setInterval(async () => {
    try {
      const health = await bullMQRetryService.getHealthStatus();
      
      if (!health.healthy) {
        logger.warn('Unhealthy status detected', { health });
        // Could send alerts here
      }
      
      // Log periodic stats
      const stats = await bullMQRetryService.getRetryQueueStats();
      logger.info('Periodic stats', {
        totalJobs: stats.bullmq.metrics.totalJobs,
        activeJobs: stats.bullmq.metrics.active,
        health: stats.systemHealth.queueHealth,
      });
      
    } catch (error) {
      console.error('[RetryQueueSetup] Error during periodic monitoring:', error);
    }
  }, intervalMs);
}

module.exports = {
  initializeRetryQueue,
  getRetryQueueHealth,
  getSystemStatus,
  setupGracefulShutdown,
  setupMonitoring,
  gracefulShutdown,
};
