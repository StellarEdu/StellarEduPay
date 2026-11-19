'use strict';

/**
 * Signed pay-link routes (#1937).
 *
 * Mounted at /api. Issue and revoke are staff endpoints scoped to the school
 * in X-School-ID; resolve is public and authenticated only by the token.
 */

const express = require('express');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { payLinkLookupLimiter } = require('../middleware/rateLimiter');
const {
  handleIssuePayLink,
  handleRevokePayLink,
  handleResolvePayLink,
} = require('../controllers/payLinkController');

const router = express.Router();

// POST /api/students/:studentId/pay-link
router.post(
  '/students/:studentId/pay-link',
  resolveSchool,
  requireSchoolAuth(['owner', 'staff']),
  auditContext,
  handleIssuePayLink,
);

// POST /api/students/:studentId/pay-link/revoke
router.post(
  '/students/:studentId/pay-link/revoke',
  resolveSchool,
  requireSchoolAuth(['owner', 'staff']),
  auditContext,
  handleRevokePayLink,
);

// GET /api/pay/:token — public
router.get('/pay/:token', payLinkLookupLimiter, handleResolvePayLink);

module.exports = router;
