'use strict';

const express = require('express');
const router  = express.Router();

const { flagDispute, getDisputes, getDisputeById, resolveDispute, addEvidence } = require('../controllers/dispute.controller');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All dispute routes require school context
router.use(resolveSchool);

// Anyone with school context can raise or view disputes
// auditContext uses req.admin which may not be present for unauthenticated flagDispute;
// the audit helper in the controller gracefully skips when req.auditContext is absent.
router.post('/',        auditContext, flagDispute);
router.get('/',         getDisputes);
router.get('/:id',      getDisputeById);

// Only admins can update dispute status / resolve / add evidence
router.patch('/:id/resolve', requireAdminAuth, auditContext, resolveDispute);
router.post('/:id/evidence', requireAdminAuth, auditContext, addEvidence);

module.exports = router;
