'use strict';

const express = require('express');
const router = express.Router();
const {
  createSchool,
  getAllSchools,
  getSchool,
  updateSchool,
  deactivateSchool,
  deactivateSchoolEndpoint,
  activateSchool,
  registerWebhook,
  getSchoolSettings,
  updateSchoolSettings,
  clearSchoolSetting,
} = require('../controllers/schoolController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// Public read endpoints
router.get('/',                 getAllSchools);
router.get('/:schoolId',        getSchool);

// Admin-only write endpoints — require JWT auth
router.post('/',                requireAdminAuth, auditContext, createSchool);
router.patch('/:schoolId',      requireAdminAuth, auditContext, updateSchool);
router.delete('/:schoolId',     requireAdminAuth, auditContext, deactivateSchool);

// Explicit activate / deactivate endpoints
router.patch('/:schoolId/deactivate', requireAdminAuth, auditContext, deactivateSchoolEndpoint);
router.patch('/:schoolId/activate',   requireAdminAuth, auditContext, activateSchool);

// Webhook registration — validates URL for SSRF safety before storing
router.post('/:slug/webhooks', requireAdminAuth, auditContext, registerWebhook);

// Per-school settings overrides
router.get('/:schoolId/settings',     requireAdminAuth, auditContext, getSchoolSettings);
router.patch('/:schoolId/settings',   requireAdminAuth, auditContext, updateSchoolSettings);
router.delete('/:schoolId/settings/:key', requireAdminAuth, auditContext, clearSchoolSetting);

module.exports = router;
