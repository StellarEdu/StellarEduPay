'use strict';

const mongoose = require('mongoose');
const SystemConfig = require('../models/systemConfigModel');
const logger = require('../utils/logger').child('MaintenanceMode');

// API docs are intentionally not exempt (Issue #1541): they must not remain
// reachable while the rest of the API is closed for maintenance.
// Auth and the maintenance toggle endpoint are exempt so administrators can
// still log in and disable maintenance through the API (Issue #1595).
const EXEMPT_PATHS = /^\/(health|metrics|api\/auth|api\/admin\/maintenance)/;

// In-memory cache for the global maintenance flag. Avoids a MongoDB round-trip
// on every request; invalidated via Redis pub/sub (see schoolCacheInvalidator)
// and refreshed at most every CACHE_TTL_MS.
const CACHE_TTL_MS = 5000;
let cachedMaintenance = null;
let cachedAt = 0;

function invalidateMaintenanceCache() {
  cachedMaintenance = null;
  cachedAt = 0;
}

async function getGlobalMaintenance() {
  const now = Date.now();
  if (cachedMaintenance !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedMaintenance;
  }
  const value = await SystemConfig.get('maintenanceMode');
  cachedMaintenance = !!value;
  cachedAt = now;
  return cachedMaintenance;
}

async function maintenanceMode(req, res, next) {
  try {
    if (EXEMPT_PATHS.test(req.path)) return next();

    // Skip the DB-backed maintenance check when the database isn't connected
    // (e.g. unit tests with mocked models). Without this, every request would
    // stall on mongoose command buffering until the ~10s buffer timeout.
    if (mongoose.connection?.readyState !== 1) return next();

    const globalMaintenance = await getGlobalMaintenance();
    if (globalMaintenance) {
      logger.warn('Global maintenance mode active — blocking request', {
        path: req.path,
        method: req.method,
      });
      res.set('Retry-After', '300');
      return res.status(503).json({
        error: 'Service is temporarily unavailable due to maintenance.',
        code: 'MAINTENANCE_MODE',
      });
    }

    // Per-school maintenance is enforced in resolveSchool, which runs inside
    // each router after req.schoolId is resolved (Issue #1595).
    next();
  } catch (err) {
    logger.error('Failed to check maintenance mode', { error: err.message });
    next();
  }
}

module.exports = { maintenanceMode, invalidateMaintenanceCache };
