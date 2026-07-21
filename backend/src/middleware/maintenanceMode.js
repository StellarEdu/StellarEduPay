'use strict';

const mongoose = require('mongoose');
const SystemConfig = require('../models/systemConfigModel');
const School = require('../models/schoolModel');
const logger = require('../utils/logger').child('MaintenanceMode');

const EXEMPT_PATHS = /^\/(health|metrics|api\/docs)/;

async function maintenanceMode(req, res, next) {
  try {
    if (EXEMPT_PATHS.test(req.path)) return next();

    // Skip the DB-backed maintenance check when the database isn't connected
    // (e.g. unit tests with mocked models). Without this, every request would
    // stall on mongoose command buffering until the ~10s buffer timeout.
    if (mongoose.connection?.readyState !== 1) return next();

    const globalMaintenance = await SystemConfig.get('maintenanceMode');
    if (globalMaintenance) {
      logger.warn('Global maintenance mode active — blocking request', {
        path: req.path,
        method: req.method,
        schoolId: req.schoolId || null,
      });
      return res.status(503).json({
        error: 'Service is temporarily unavailable due to maintenance.',
        code: 'MAINTENANCE_MODE',
      });
    }

    if (req.schoolId) {
      const school = await School.findOne({ schoolId: req.schoolId }, { maintenanceMode: 1 }).lean();
      if (school && school.maintenanceMode) {
        logger.warn('Per-school maintenance mode active — blocking request', {
          path: req.path,
          method: req.method,
          schoolId: req.schoolId,
        });
        return res.status(503).json({
          error: 'This school is temporarily unavailable due to maintenance.',
          code: 'SCHOOL_MAINTENANCE_MODE',
        });
      }
    }

    next();
  } catch (err) {
    logger.error('Failed to check maintenance mode', { error: err.message });
    next();
  }
}

module.exports = { maintenanceMode };
