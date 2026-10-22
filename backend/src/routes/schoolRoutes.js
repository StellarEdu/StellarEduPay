'use strict';

const express = require('express');
const router = express.Router();
const {
  createSchool,
  getAllSchools,
  getSchool,
  updateSchool,
  rotateStellarAddress,
  rotateWebhookSecret,
  deactivateSchool,
  deprecatedDeleteSchool,
  activateSchool,
  registerWebhook,
  getSchoolSettings,
  updateSchoolSettings,
  clearSchoolSetting,
} = require('../controllers/schoolController');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// ?includeInactive=true requires admin auth (cookie or Bearer, admin/super_admin)
function adminAuthForInactive(req, res, next) {
  if (req.query.includeInactive === 'true') return requireAdminAuth(req, res, next);
  next();
}

// Public read endpoints
router.get('/',                 adminAuthForInactive, getAllSchools);
router.get('/:schoolId',        getSchool);

// Admin-only write endpoints — require JWT auth
router.post('/',                requireAdminAuth, auditContext, createSchool);
router.patch('/:schoolId',      requireAdminAuth, auditContext, updateSchool);
// Deprecated: use PATCH /:schoolId/deactivate. Kept as an alias for one release.
router.delete('/:schoolId',     requireAdminAuth, auditContext, deprecatedDeleteSchool);

// Dedicated wallet-rotation endpoint — step-up auth + mandatory reason (#1387)
router.put('/:schoolId/stellar-address', requireAdminAuth, auditContext, rotateStellarAddress);

// Dedicated webhookSecret rotation endpoint — step-up auth (#1412)
router.put('/:schoolId/webhook-secret', requireAdminAuth, auditContext, rotateWebhookSecret);

// Explicit activate / deactivate endpoints
router.patch('/:schoolId/deactivate', requireAdminAuth, auditContext, deactivateSchool);
router.patch('/:schoolId/activate',   requireAdminAuth, auditContext, activateSchool);

// Webhook registration — validates URL for SSRF safety before storing
router.post('/:slug/webhooks', requireAdminAuth, auditContext, registerWebhook);

// Per-school settings overrides
router.get('/:schoolId/settings',     requireAdminAuth, auditContext, getSchoolSettings);
router.patch('/:schoolId/settings',   requireAdminAuth, auditContext, updateSchoolSettings);
router.delete('/:schoolId/settings/:key', requireAdminAuth, auditContext, clearSchoolSetting);

module.exports = router;
