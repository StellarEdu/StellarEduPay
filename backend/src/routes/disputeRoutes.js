'use strict';

const express = require('express');
const router  = express.Router();

const { flagDispute, getDisputes, getDisputeById, resolveDispute, addEvidence } = require('../controllers/dispute.controller');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All dispute routes require school context
router.use(resolveSchool);

// Staff+ can flag and view disputes
router.post('/',        requireSchoolAuth(['owner', 'staff']), auditContext, flagDispute);
router.get('/',         requireSchoolAuth(['owner', 'staff', 'read_only']), getDisputes);
router.get('/:id',      requireSchoolAuth(['owner', 'staff', 'read_only']), getDisputeById);

// Only owner/staff can resolve disputes
router.patch('/:id/resolve', requireSchoolAuth(['owner', 'staff']), auditContext, resolveDispute);
router.post('/:id/evidence', requireSchoolAuth(['owner', 'staff']), auditContext, addEvidence);

module.exports = router;
