'use strict';

const express = require('express');
const router = express.Router();

const { createRule, getRules, deleteRule } = require('../controllers/sourceValidationRuleController');
const { requireAdminAuth } = require('../middleware/auth');
const { resolveSchool } = require('../middleware/schoolContext');
const { auditContext } = require('../middleware/auditContext');

/**
 * Source validation rules are tenant-scoped per school.
 * All routes require:
 *   1. resolveSchool — populates req.schoolId from the X-School-ID header
 *                      (or JWT claim).  Returns 400 if missing.
 *   2. requireAdminAuth — only school admins may manage source rules.
 *
 * Unmatched-sender default: ALLOW.
 * See sourceValidationRuleModel.js for full semantics.
 */
router.use(resolveSchool);

router.post('/',      requireAdminAuth, auditContext, createRule);
router.get('/',       requireAdminAuth, getRules);
router.delete('/:id', requireAdminAuth, auditContext, deleteRule);

module.exports = router;
