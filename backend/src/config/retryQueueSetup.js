/**
 * Retry Queue Setup and Initialization
 * 
 * This module handles the startup and integration of the BullMQ
 * retry queue system with the main application.
 */

const bullMQRetryService = require('../services/bullMQRetryService');
const retryQueueRoutes = require('../routes/retryQueueRoutes');

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
    console.log('[RetryQueueSetup] Already initialized');
    return;
  }

  try {
    console.log('[RetryQueueSetup] Starting initialization...');

    // Initialize the BullMQ queue system
    await bullMQRetryService.initializeRetryQueue();

    console.log('[RetryQueueSetup] BullMQ queue system initialized');

    // Register routes if app is provided
    if (app) {
      app.use('/api/retry-queue', retryQueueRoutes);
      console.log('[RetryQueueSetup] Routes registered at /api/retry-queue');
    }

    // Main application manages process signal handling to avoid duplicate shutdown paths.
    setupGracefulShutdown();

    isInitialized = true;
    initState = { status: 'ok', error: null };
    console.log('[RetryQueueSetup] Initialization complete');

    return {
      success: true,
      message: 'Retry queue system initialized successfully',
    };

  } catch (error) {
    initState = { status: 'failed', error: error.message };
    console.error('[RetryQueueSetup] Initialization failed:', error);
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
  console.log('[RetryQueueSetup] Main application manages process shutdown; skipping duplicate signal handlers');
}

/**
 * Graceful shutdown function
 */
async function gracefulShutdown() {
  try {
    console.log('[RetryQueueSetup] Starting graceful shutdown...');
    
    // Get final stats before shutdown
    const stats = await bullMQRetryService.getRetryQueueStats();
    console.log('[RetryQueueSetup] Final queue stats:', stats);
    
    // Shutdown the queue system
    await bullMQRetryService.shutdownQueue();
    
    console.log('[RetryQueueSetup] Graceful shutdown complete');
    
  } catch (error) {
    console.error('[RetryQueueSetup] Error during graceful shutdown:', error);
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
  console.log(`[RetryQueueSetup] Setting up monitoring with ${intervalMs}ms interval`);
  
  setInterval(async () => {
    try {
      const health = await bullMQRetryService.getHealthStatus();
      
      if (!health.healthy) {
        console.warn('[RetryQueueSetup] Unhealthy status detected:', health);
        // Could send alerts here
      }
      
      // Log periodic stats
      const stats = await bullMQRetryService.getRetryQueueStats();
      console.log('[RetryQueueSetup] Periodic stats:', {
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
