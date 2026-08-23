'use strict';

const express = require('express');
const router  = express.Router();

const { flagDispute, getDisputes, getDisputeById, resolveDispute, addEvidence } = require('../controllers/dispute.controller');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All dispute routes require school context
router.use(resolveSchool);

// Every dispute handler requires a school-scoped JWT (tenant binding is
// enforced by requireSchoolAuth against X-School-ID). Dispute records join
// student identity to payment history and free-text narrative — they are not
// readable, creatable, or listable on the strength of the school header alone.
//
// If a genuinely anonymous parent-facing dispute form becomes a product
// requirement, mount it as an explicit public route with its own rate limiting
// and captcha/signed-link requirement — see docs/threat-model.md and
// backend/src/config/publicEndpoints.js. Do NOT un-protect this handler.
const requireTenantAuth = requireSchoolAuth();

router.post('/',        requireTenantAuth, auditContext, flagDispute);
router.get('/',         requireTenantAuth, getDisputes);
router.get('/:id',      requireTenantAuth, getDisputeById);

// Only admins can update dispute status / resolve / add evidence
router.patch('/:id/resolve', requireAdminAuth, auditContext, resolveDispute);
router.post('/:id/evidence', requireAdminAuth, auditContext, addEvidence);

module.exports = router;
