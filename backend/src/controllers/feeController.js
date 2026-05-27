'use strict';

const FeeStructure = require('../models/feeStructureModel');
const { get, set, del, KEYS, TTL } = require('../cache');
const { logAudit } = require('../services/auditService');

// POST /api/fees
async function createFeeStructure(req, res, next) {
  try {
    const { schoolId } = req; // injected by resolveSchool middleware
    const { className, feeAmount, description, academicYear, paymentDeadline } = req.body;
    if (!className || feeAmount == null) {
      const err = new Error('className and feeAmount are required');
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    // Check for existing active fee structure for same class/academic year
    const existing = await FeeStructure.findOne({
      schoolId,
      className,
      isActive: true,
    });

    if (existing) {
      const err = new Error(
        `An active fee structure already exists for class ${className} in academic year ${existing.academicYear}`
      );
      err.code = 'DUPLICATE_FEE_STRUCTURE';
      err.status = 409;
      return next(err);
    }

    const fee = await FeeStructure.create({
      schoolId,
      className,
      feeAmount,
      description,
      academicYear: academicYear || new Date().getUTCFullYear().toString(),
      isActive: true,
      paymentDeadline: paymentDeadline || null,
    });

    // Invalidate fee caches so next read reflects the change
    del(KEYS.feesAll(), KEYS.feeByClass(className));

    // Audit log
    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'fee_create',
        performedBy: req.auditContext.performedBy,
        targetId: className,
        targetType: 'fee',
        details: {
          className,
          feeAmount,
          description,
          academicYear,
          paymentDeadline,
        },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.status(201).json(fee);
  } catch (err) {
    next(err);
  }
}

// GET /api/fees
async function getAllFeeStructures(req, res, next) {
  try {
    const cacheKey = KEYS.feesAll();
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const fees = await FeeStructure.find({ schoolId: req.schoolId, isActive: true }).sort({ className: 1 });
    set(cacheKey, fees, TTL.FEES);
    res.json(fees);
  } catch (err) {
    next(err);
  }
}

// GET /api/fees/:className
async function getFeeByClass(req, res, next) {
  try {
    const { className } = req.params;
    const cacheKey = KEYS.feeByClass(className);
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const fee = await FeeStructure.findOne({
      schoolId: req.schoolId,
      className: req.params.className,
      isActive: true,
    });
    if (!fee) {
      const err = new Error(`No fee structure found for class ${className}`);
      err.code = 'NOT_FOUND';
      return next(err);
    }
    set(cacheKey, fee, TTL.FEES);
    res.json(fee);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/fees/:className
async function deleteFeeStructure(req, res, next) {
  try {
    const { className } = req.params;
    const force = req.query.force === 'true';

    const Student = require('../models/studentModel');
    const affectedCount = await Student.countDocuments({
      schoolId: req.schoolId,
      class: className,
      feePaid: false,
      deletedAt: null,
    });

    if (affectedCount > 0 && !force) {
      const err = new Error(
        `${affectedCount} student(s) in class ${className} have unpaid fees. Use ?force=true to deactivate anyway.`
      );
      err.code = 'CONFLICT';
      err.status = 409;
      err.details = { affectedCount };
      return next(err);
    }

    const fee = await FeeStructure.findOneAndUpdate(
      { schoolId: req.schoolId, className: req.params.className },
      { isActive: false },
      { new: true }
    );
    if (!fee) {
      const err = new Error('Fee structure not found');
      err.code = 'NOT_FOUND';
      return next(err);
    }

    if (affectedCount > 0) {
      const logger = require('../utils/logger');
      logger.warn('Fee structure deactivated with active student obligations', {
        schoolId: req.schoolId,
        className,
        affectedStudents: affectedCount,
      });
    }

    // Invalidate fee caches
    del(KEYS.feesAll(), KEYS.feeByClass(className));

    // Audit log
    if (req.auditContext) {
      await logAudit({
        schoolId: req.schoolId,
        action: 'fee_delete',
        performedBy: req.auditContext.performedBy,
        targetId: className,
        targetType: 'fee',
        details: { className, feeAmount: fee.feeAmount },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ message: `Fee structure for class ${className} deactivated` });
  } catch (err) {
    next(err);
  }
}

// PUT /api/fees/:className
async function updateFeeStructure(req, res, next) {
  try {
    const { className } = req.params;
    const { feeAmount, description, academicYear, paymentDeadline, cascadeToStudents } = req.body;

    if (feeAmount == null) {
      const err = new Error('feeAmount is required');
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    // Build update object — only include fields explicitly provided
    const updateFields = { feeAmount };
    if (description !== undefined) updateFields.description = description;
    if (academicYear !== undefined) updateFields.academicYear = academicYear;
    if (paymentDeadline !== undefined) updateFields.paymentDeadline = paymentDeadline;

    const fee = await FeeStructure.findOneAndUpdate(
      { schoolId: req.schoolId, className, isActive: true },
      updateFields,
      { new: true, runValidators: true }
    );

    if (!fee) {
      const err = new Error(`No active fee structure found for class ${className}`);
      err.code = 'NOT_FOUND';
      return next(err);
    }

    // Invalidate fee caches
    del(KEYS.feesAll(), KEYS.feeByClass(className));

    // Optionally cascade feeAmount update to all students in this class
    let studentsUpdated = 0;
    if (cascadeToStudents === true) {
      const Student = require('../models/studentModel');
      const students = await Student.find({ schoolId: req.schoolId, class: className, deletedAt: null });
      
      // Process in batches of 500 to avoid memory issues
      const BATCH_SIZE = 500;
      for (let i = 0; i < students.length; i += BATCH_SIZE) {
        const batch = students.slice(i, i + BATCH_SIZE);
        for (const student of batch) {
          student.feeAmount = feeAmount;
          student.remainingBalance = Math.max(0, feeAmount - (student.totalPaid || 0));
          student.feePaid = (student.totalPaid || 0) >= feeAmount;
          await student.save(); // triggers pre-save hook for fees array sync
          studentsUpdated++;
        }
      }
    }

    // Audit log
    if (req.auditContext) {
      await logAudit({
        schoolId: req.schoolId,
        action: 'fee_update',
        performedBy: req.auditContext.performedBy,
        targetId: className,
        targetType: 'fee',
        details: { className, feeAmount, description, academicYear, paymentDeadline, cascadeToStudents, studentsUpdated },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ fee, studentsUpdated });
  } catch (err) {
    next(err);
  }
}

module.exports = { createFeeStructure, getAllFeeStructures, getFeeByClass, deleteFeeStructure, updateFeeStructure };
