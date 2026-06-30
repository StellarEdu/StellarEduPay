'use strict';

/**
 * Source Validation Rule Controller
 *
 * All CRUD operations are strictly tenant-scoped: every query includes
 * `schoolId` derived from `req.schoolId` (populated by the `resolveSchool`
 * middleware).  Cross-tenant access is structurally impossible — a request
 * carrying School A's context cannot read or mutate School B's rules.
 *
 * Unmatched-sender behaviour
 * --------------------------
 * When a payment arrives from a sender address that matches no active rule for
 * this school the system defaults to ALLOW.  See sourceValidationRuleModel.js
 * for the full rationale and how to configure a deny-by-default posture.
 */

const SourceValidationRule = require('../models/sourceValidationRuleModel');
const { logAudit } = require('../services/auditService');

// Source validation rules are global (not per-school).
// We use schoolId: 'system' to keep audit entries in the same chain.
function audit(req, action, targetId, details) {
  if (!req.auditContext) return Promise.resolve();
  return logAudit({
    schoolId: 'system',
    action,
    performedBy: req.auditContext.performedBy,
    targetId,
    targetType: 'source_validation_rule',
    details,
    result: 'success',
    ipAddress: req.auditContext.ipAddress,
    userAgent: req.auditContext.userAgent,
  });
}

// POST /api/source-rules
async function createRule(req, res, next) {
  try {
    const { name, type, value, description, isActive, priority, maxTransactionsPerDay } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required.', code: 'VALIDATION_ERROR' });
    }

    const VALID_TYPES = ['blacklist', 'whitelist', 'pattern', 'new_sender_limit'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: `type must be one of: ${VALID_TYPES.join(', ')}.`,
        code: 'VALIDATION_ERROR',
      });
    }

    if (['blacklist', 'whitelist', 'pattern'].includes(type) && !value) {
      return res.status(400).json({
        error: `value is required for type "${type}".`,
        code: 'VALIDATION_ERROR',
      });
    }

    if (type === 'pattern') {
      try {
        new RegExp(value); // eslint-disable-line no-new
      } catch {
        return res.status(400).json({ error: 'value is not a valid regular expression.', code: 'VALIDATION_ERROR' });
      }
    }

    // Duplicate check is scoped to this school only
    const existing = await SourceValidationRule.findOne({ schoolId: req.schoolId, name });
    if (existing) {
      return res.status(409).json({ error: `A rule named "${name}" already exists.`, code: 'DUPLICATE_RULE' });
    }

    const rule = await SourceValidationRule.create({
      schoolId: req.schoolId,
      name,
      type,
      value: value || null,
      description: description || null,
      isActive: isActive !== undefined ? isActive : true,
      priority: priority !== undefined ? priority : 10,
      maxTransactionsPerDay: type === 'new_sender_limit' ? (maxTransactionsPerDay || 1) : null,
    });

    await audit(req, 'source_validation_rule_create', String(rule._id), {
      name: rule.name, type: rule.type, value: rule.value, priority: rule.priority,
    });
    res.status(201).json(rule);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: `A rule with that name already exists for this school.`,
        code: 'DUPLICATE_RULE',
      });
    }
    next(err);
  }
}

// GET /api/source-rules
async function getRules(req, res, next) {
  try {
    // Always scope by schoolId — tenant isolation
    const filter = { schoolId: req.schoolId };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const rules = await SourceValidationRule.find(filter).sort({ priority: 1, createdAt: 1 });
    res.json(rules);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/source-rules/:id
async function deleteRule(req, res, next) {
  try {
    // Include schoolId so a school cannot delete another school's rule
    const rule = await SourceValidationRule.findOneAndDelete({
      _id: req.params.id,
      schoolId: req.schoolId,
    });
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found.', code: 'NOT_FOUND' });
    }
    await audit(req, 'source_validation_rule_delete', String(rule._id), {
      name: rule.name, type: rule.type, value: rule.value,
    });
    res.json({ message: `Rule "${rule.name}" deleted.` });
  } catch (err) {
    next(err);
  }
}

module.exports = { createRule, getRules, deleteRule };
