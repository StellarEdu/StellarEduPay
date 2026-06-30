'use strict';

const express = require('express');
const router = express.Router();
const {
  createRule,
  listRules,
  updateRule,
  deleteRule,
  dryRunRule,
  applyRule,
} = require('../controllers/feeAdjustmentController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

router.use(resolveSchool);

// ── CRUD ─────────────────────────────────────────────────────────────────────
router.post('/',      requireAdminAuth, auditContext, createRule);
router.get('/',       listRules);
router.put('/:id',    requireAdminAuth, auditContext, updateRule);
router.delete('/:id', requireAdminAuth, auditContext, deleteRule);

// ── #901 Dry-run preview ─────────────────────────────────────────────────────
// POST /api/fee-adjustments/dry-run
// Simulate a rule against the current student cohort without persisting.
// Precedence: rules sorted by priority ASC (lower = higher precedence), then name.
router.post('/dry-run', requireAdminAuth, dryRunRule);

// ── #902 Batch/transactional apply ───────────────────────────────────────────
// POST /api/fee-adjustments/:id/apply
// Apply an existing rule to matching students via bulkWrite inside a session.
router.post('/:id/apply', requireAdminAuth, applyRule);

module.exports = router;
