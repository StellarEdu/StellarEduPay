'use strict';

const mongoose = require('mongoose');
const FeeAdjustmentRule = require('../models/feeAdjustmentRuleModel');
const Student = require('../models/studentModel');
const feeAdjustmentService = require('../services/feeAdjustmentService');
const logger = require('../utils/logger');
const { logAudit } = require('../services/auditService');

const VALID_TYPES = ['discount_percentage', 'discount_fixed', 'penalty_percentage', 'penalty_fixed', 'waiver'];
const VALID_POLICIES = ['stack', 'first_only', 'best_for_student'];

function validateBody(body) {
  const { name, type, value } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return 'name is required';
  if (!VALID_TYPES.includes(type)) return `type must be one of: ${VALID_TYPES.join(', ')}`;
  if (value == null || typeof value !== 'number' || value < 0) return 'value must be a non-negative number';
  if (body.conflictResolutionPolicy !== undefined && !VALID_POLICIES.includes(body.conflictResolutionPolicy)) {
    return `conflictResolutionPolicy must be one of: ${VALID_POLICIES.join(', ')}`;
  }
  return null;
}

function audit(req, action, targetId, details) {
  if (!req.auditContext) return Promise.resolve();
  return logAudit({
    schoolId: req.schoolId,
    action,
    performedBy: req.auditContext.performedBy,
    targetId,
    targetType: 'fee_adjustment_rule',
    details,
    result: 'success',
    ipAddress: req.auditContext.ipAddress,
    userAgent: req.auditContext.userAgent,
  });
}

// POST /api/fee-adjustments
async function createRule(req, res, next) {
  try {
    const validationError = validateBody(req.body);
    if (validationError) {
      const err = new Error(validationError);
      err.code = 'VALIDATION_ERROR';
      err.status = 400;
      return next(err);
    }

    const { name, type, value, conditions, priority, description, conflictResolutionPolicy } = req.body;
    const rule = await FeeAdjustmentRule.create({
      schoolId: req.schoolId,
      name: name.trim(),
      type,
      value,
      conditions: conditions || {},
      priority: priority ?? 10,
      conflictResolutionPolicy: conflictResolutionPolicy || 'stack',
      description,
      isActive: true,
    });

    await audit(req, 'fee_adjustment_rule_create', String(rule._id), {
      name: rule.name, type, value, conditions: conditions || {}, priority: priority ?? 10,
    });
    res.status(201).json(rule);
  } catch (err) {
    if (err.code === 11000) {
      err.message = `A rule named "${req.body.name}" already exists for this school`;
      err.code = 'DUPLICATE_RULE';
      err.status = 409;
    }
    next(err);
  }
}

// GET /api/fee-adjustments
async function listRules(req, res, next) {
  try {
    // Sort by priority ASC (lower number = higher precedence), then name for determinism
    const rules = await FeeAdjustmentRule.find({ schoolId: req.schoolId }).sort({ priority: 1, name: 1 });
    res.json(rules);
  } catch (err) {
    next(err);
  }
}

// PUT /api/fee-adjustments/:id
async function updateRule(req, res, next) {
  try {
    const validationError = validateBody(req.body);
    if (validationError) {
      const err = new Error(validationError);
      err.code = 'VALIDATION_ERROR';
      err.status = 400;
      return next(err);
    }

    const { name, type, value, conditions, priority, description, isActive, conflictResolutionPolicy } = req.body;

    // Capture before state for audit trail
    const before = await FeeAdjustmentRule.findOne({ _id: req.params.id, schoolId: req.schoolId }).lean();

    const rule = await FeeAdjustmentRule.findOneAndUpdate(
      { _id: req.params.id, schoolId: req.schoolId },
      { name: name.trim(), type, value, conditions, priority, description, isActive,
        ...(conflictResolutionPolicy !== undefined ? { conflictResolutionPolicy } : {}) },
      { new: true, runValidators: true }
    );

    if (!rule) {
      const err = new Error('Fee adjustment rule not found');
      err.code = 'NOT_FOUND';
      err.status = 404;
      return next(err);
    }

    await audit(req, 'fee_adjustment_rule_update', String(rule._id), {
      before: before ? { name: before.name, type: before.type, value: before.value, isActive: before.isActive } : null,
      after:  { name: rule.name, type: rule.type, value: rule.value, isActive: rule.isActive },
    });
    res.json(rule);
  } catch (err) {
    if (err.code === 11000) {
      err.message = `A rule named "${req.body.name}" already exists for this school`;
      err.code = 'DUPLICATE_RULE';
      err.status = 409;
    }
    next(err);
  }
}

// DELETE /api/fee-adjustments/:id  — soft delete (deactivate)
async function deleteRule(req, res, next) {
  try {
    const rule = await FeeAdjustmentRule.findOneAndUpdate(
      { _id: req.params.id, schoolId: req.schoolId },
      { isActive: false },
      { new: true }
    );

    if (!rule) {
      const err = new Error('Fee adjustment rule not found');
      err.code = 'NOT_FOUND';
      err.status = 404;
      return next(err);
    }

    await audit(req, 'fee_adjustment_rule_delete', String(rule._id), {
      name: rule.name, type: rule.type, value: rule.value,
    });
    res.json({ message: `Rule "${rule.name}" deactivated` });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/fee-adjustments/dry-run
 *
 * Preview the effect of a new/hypothetical rule (or a set of rules) on a
 * cohort without persisting anything.
 *
 * Body:
 *   {
 *     "rule": { name, type, value, conditions, priority, conflictResolutionPolicy },
 *     "studentClass": "JSS1",          // optional cohort filter
 *     "academicYear": "2026",          // optional
 *     "paymentDate": "2026-07-01"      // optional, defaults to now
 *   }
 *
 * Returns per-student previews and an aggregate summary.
 */
async function dryRunRule(req, res, next) {
  try {
    const { rule: ruleBody, studentClass, academicYear, paymentDate } = req.body;

    if (!ruleBody || !ruleBody.type || ruleBody.value == null) {
      const err = new Error('rule with type and value is required for dry-run');
      err.code = 'VALIDATION_ERROR';
      err.status = 400;
      return next(err);
    }

    if (!VALID_TYPES.includes(ruleBody.type)) {
      const err = new Error(`rule.type must be one of: ${VALID_TYPES.join(', ')}`);
      err.code = 'VALIDATION_ERROR';
      err.status = 400;
      return next(err);
    }

    // Build a synthetic (unsaved) rule document for simulation
    const syntheticRule = {
      schoolId: req.schoolId,
      name: ruleBody.name || '_dry_run_preview_',
      type: ruleBody.type,
      value: ruleBody.value,
      conditions: ruleBody.conditions || {},
      priority: ruleBody.priority ?? 10,
      conflictResolutionPolicy: ruleBody.conflictResolutionPolicy || 'stack',
      isActive: true,
    };

    // Fetch students matching the cohort filter (active, not soft-deleted)
    const studentFilter = { schoolId: req.schoolId, deletedAt: null };
    if (studentClass) studentFilter.class = studentClass;
    if (academicYear) studentFilter.academicYear = academicYear;

    const students = await Student.find(studentFilter).lean();

    const effectivePaymentDate = paymentDate ? new Date(paymentDate) : new Date();
    const previews = [];
    let totalSavings = 0;
    let totalSurcharges = 0;
    let affectedCount = 0;

    for (const student of students) {
      // Calculate fee without the new rule first (using existing active rules)
      const baseCtx = {
        schoolId: req.schoolId,
        student,
        academicYear: student.academicYear,
        paymentDate: effectivePaymentDate,
        baseAmount: student.feeAmount,
      };

      const feeStructure = { feeAmount: student.feeAmount };

      // Simulate with existing rules only
      const existingResult = await feeAdjustmentService.calculateAdjustedFee(feeStructure, baseCtx);

      // Now inject the new rule into the simulation
      const withNewResult = await feeAdjustmentService.simulateWithExtra(
        feeStructure,
        baseCtx,
        syntheticRule
      );

      const delta = withNewResult.finalFee - existingResult.finalFee;

      if (delta !== 0) {
        affectedCount++;
        if (delta < 0) totalSavings += Math.abs(delta);
        else totalSurcharges += delta;
      }

      previews.push({
        studentId: student.studentId,
        name: student.name,
        class: student.class,
        currentFee: existingResult.finalFee,
        projectedFee: withNewResult.finalFee,
        delta,
        adjustmentsApplied: withNewResult.adjustmentsApplied,
        ruleWouldApply: withNewResult.ruleApplied,
        overpaymentRisk: student.totalPaid > withNewResult.finalFee,
      });
    }

    res.json({
      dryRun: true,
      rule: syntheticRule,
      summary: {
        totalStudents: students.length,
        affectedStudents: affectedCount,
        unaffectedStudents: students.length - affectedCount,
        totalSavings: parseFloat(totalSavings.toFixed(2)),
        totalSurcharges: parseFloat(totalSurcharges.toFixed(2)),
        overpaymentRisks: previews.filter(p => p.overpaymentRisk).length,
      },
      previews,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/fee-adjustments/:id/apply
 *
 * Apply an existing fee adjustment rule to all matching students of a school
 * using bulkWrite within a MongoDB session for atomicity.
 *
 * Body (optional):
 *   {
 *     "studentClass": "JSS1",    // narrow to a class
 *     "academicYear": "2026",    // narrow to an academic year
 *     "paymentDate": "2026-07-01"
 *   }
 *
 * Returns a progress/status object.
 * For large cohorts the operation runs synchronously and returns when complete;
 * the status record is included in the response for client-side idempotency.
 *
 * Precedence / conflict resolution
 * ---------------------------------
 * Existing active rules for the school are fetched and evaluated in priority
 * order (asc).  The rule being applied is inserted at its declared priority.
 * If it ties with another rule on priority, name ordering breaks the tie.
 * The `conflictResolutionPolicy` field on each rule controls stacking behaviour:
 *   - "stack"             → all matching rules applied sequentially (default)
 *   - "first_only"        → stops after the first matching rule per student
 *   - "best_for_student"  → picks the matching discount that saves most
 */
async function applyRule(req, res, next) {
  let session;
  try {
    session = await mongoose.startSession();
    const rule = await FeeAdjustmentRule.findOne({
      _id: req.params.id,
      schoolId: req.schoolId,
      isActive: true,
    });

    if (!rule) {
      const err = new Error('Fee adjustment rule not found or inactive');
      err.code = 'NOT_FOUND';
      err.status = 404;
      return next(err);
    }

    const { studentClass, academicYear, paymentDate } = req.body || {};

    // Fetch students matching the cohort filter
    const studentFilter = { schoolId: req.schoolId, deletedAt: null };
    if (studentClass) studentFilter.class = studentClass;
    if (academicYear) studentFilter.academicYear = academicYear;

    const students = await Student.find(studentFilter).lean();

    const effectivePaymentDate = paymentDate ? new Date(paymentDate) : new Date();
    const bulkOps = [];
    const results = { applied: 0, skipped: 0, overpayments: [], errors: [] };

    for (const student of students) {
      try {
        const feeStructure = { feeAmount: student.feeAmount };
        const ctx = {
          schoolId: req.schoolId,
          student,
          academicYear: student.academicYear,
          paymentDate: effectivePaymentDate,
          baseAmount: student.feeAmount,
        };

        const adjusted = await feeAdjustmentService.calculateAdjustedFee(feeStructure, ctx);
        const newFee = adjusted.finalFee;

        if (newFee === student.feeAmount) {
          // Rule didn't change anything for this student
          results.skipped++;
          continue;
        }

        const newRemainingBalance = Math.max(0, newFee - (student.totalPaid || 0));
        const feePaid = newRemainingBalance === 0 && newFee > 0
          ? (student.totalPaid || 0) >= newFee
          : student.feePaid;

        // Detect overpayment: student already paid more than the new (lower) fee
        const isOverpayment = (student.totalPaid || 0) > newFee;
        if (isOverpayment) {
          results.overpayments.push({
            studentId: student.studentId,
            name: student.name,
            previousFee: student.feeAmount,
            newFee,
            amountPaid: student.totalPaid || 0,
            creditAmount: parseFloat(((student.totalPaid || 0) - newFee).toFixed(2)),
          });
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: student._id, schoolId: req.schoolId },
            update: {
              $set: {
                feeAmount: newFee,
                remainingBalance: newRemainingBalance,
                feePaid,
              },
            },
          },
        });

        results.applied++;
      } catch (studentErr) {
        results.errors.push({ studentId: student.studentId, error: studentErr.message });
      }
    }

    // Execute all updates inside a transaction for atomicity
    if (bulkOps.length > 0) {
      await session.withTransaction(async () => {
        await Student.bulkWrite(bulkOps, { session });
      });
    }

    logger.info({
      msg: 'Fee adjustment rule applied',
      ruleId: rule._id,
      ruleName: rule.name,
      schoolId: req.schoolId,
      studentsProcessed: students.length,
      applied: results.applied,
      skipped: results.skipped,
      overpayments: results.overpayments.length,
    });

    res.json({
      status: 'completed',
      ruleId: rule._id,
      ruleName: rule.name,
      studentsProcessed: students.length,
      studentsUpdated: results.applied,
      studentsSkipped: results.skipped,
      overpaymentCount: results.overpayments.length,
      overpayments: results.overpayments,
      errors: results.errors,
    });
  } catch (err) {
    next(err);
  } finally {
    if (session) session.endSession();
  }
}

module.exports = { createRule, listRules, updateRule, deleteRule, dryRunRule, applyRule };
