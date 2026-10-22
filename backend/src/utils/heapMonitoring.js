'use strict';

const logger = require('./logger');

let iv = null;

function startHeapMonitoring() {
  if (iv) return;
  const { heap_size_limit: max } = require('v8').getHeapStatistics();
  const threshold = max * 0.8;

  let metricsModule;
  try {
    metricsModule = require('../metrics');
  } catch (_) {
    // Metrics module might not be loaded yet
  }

  iv = setInterval(() => {
    const used = process.memoryUsage().heapUsed;
    const ratio = used / max;

    // Emit Prometheus gauge
    if (metricsModule?.nodejsHeapUsedRatio) {
      metricsModule.nodejsHeapUsedRatio.set(ratio);
    }

    if (used > threshold) {
      logger.warn('HEAP_USAGE_WARNING', {
        heapUsedMB: Math.round(used / 1024 / 1024),
        maxHeapSizeMB: Math.round(max / 1024 / 1024),
        usagePercent: Math.round((used / max) * 100),
      });
    }
  }, 30000);
  iv.unref();
}

function stopHeapMonitoring() {
  if (iv) {
    clearInterval(iv);
    iv = null;
  }
}

module.exports = { startHeapMonitoring, stopHeapMonitoring };
