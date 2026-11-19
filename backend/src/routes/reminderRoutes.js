'use strict';

const express = require('express');
const router  = express.Router();
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { resolveSchool } = require('../middleware/schoolContext');
const { reminderTriggerLimiter } = require('../middleware/rateLimiter');
const {
  triggerReminders,
  previewReminders,
  setOptOut,
  unsubscribeViaToken,
  confirmUnsubscribeViaToken,
  resubscribeViaToken,
} = require('../controllers/reminderController');

// RFC 8058 one-click unsubscribe posts "List-Unsubscribe=One-Click" as a form body.
const parseForm = express.urlencoded({ extended: false, limit: '1kb' });

// Public unsubscribe endpoints (no auth required; authorised by signed token).
// Issue #1542: GET only renders a confirmation page so link pre-fetching by
// email security scanners cannot opt parents out; POST performs the change.
router.get('/unsubscribe', unsubscribeViaToken);
router.post('/unsubscribe', parseForm, confirmUnsubscribeViaToken);
router.post('/resubscribe', parseForm, resubscribeViaToken);

// All other reminder routes require school auth + owner/staff role
router.use(requireSchoolAuth(['owner', 'staff']));
router.use(resolveSchool);

router.post('/trigger', reminderTriggerLimiter, triggerReminders);
router.get('/preview',   previewReminders);
router.post('/opt-out',  setOptOut);

module.exports = router;
