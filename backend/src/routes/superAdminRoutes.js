'use strict';

const express = require('express');
const router = express.Router();
const { listSchools, getMetrics, updateQuota } = require('../controllers/superAdminController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All routes require a platform super-admin JWT (env admin or roles:['super_admin']),
// which is never scoped to a single schoolId.
router.get('/schools', requireAdminAuth, listSchools);
router.get('/metrics', requireAdminAuth, getMetrics);
router.patch('/schools/:schoolId/quota', requireAdminAuth, auditContext, updateQuota);

module.exports = router;
