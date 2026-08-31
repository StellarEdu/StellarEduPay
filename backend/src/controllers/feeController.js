'use strict';

const mongoose = require('mongoose');
const FeeStructure = require('../models/feeStructureModel');
const { get, set, del, KEYS, TTL } = require('../cache');
const { logAudit } = require('../services/auditService');
const logger = require('../utils/logger');

function audit(req, action, targetId, details) {
  if (!req.auditContext) return Promise.resolve();
  return logAudit({ schoolId: req.schoolId, action, performedBy: req.auditContext.performedBy, targetId, targetType: 'fee', details, result: 'success', ipAddress: req.auditContext.ipAddress, userAgent: req.auditContext.userAgent });
}

async function createFeeStructure(req, res, next) {
  try {
    const { schoolId } = req;
    const { className, feeAmount, description, academicYear, paymentDeadline } = req.body;
    if (!className || feeAmount == null) return next(Object.assign(new Error('className and feeAmount are required'), { code: 'VALIDATION_ERROR' }));

    const existing = await FeeStructure.findOne({ schoolId, className, isActive: true });
    if (existing) return next(Object.assign(new Error(`Active fee structure already exists for class ${className}`), { code: 'DUPLICATE_FEE_STRUCTURE', status: 409 }));

    const fee = await FeeStructure.create({ schoolId, className, feeAmount, description, academicYear: academicYear || new Date().getUTCFullYear().toString(), isActive: true, paymentDeadline: paymentDeadline || null });
    del(KEYS.feesAll(), KEYS.feeByClass(className));
    await audit(req, 'fee_create', className, { className, feeAmount, academicYear });
    res.status(201).json(fee);
  } catch (err) { next(err); }
}

async function getAllFeeStructures(req, res, next) {
  try {
    const includeDeleted = req.query.includeDeleted === 'true';
    const isAdmin = Boolean(req.admin);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;

    const filter = { schoolId: req.schoolId, ...(isAdmin ? {} : { isActive: true }), ...(includeDeleted ? {} : { deletedAt: null }) };
    const query = FeeStructure.find(filter);
    if (includeDeleted) query.includeDeleted();

    const [fees, total] = await Promise.all([
      query.sort({ className: 1 }).skip(skip).limit(limit).lean(),
      FeeStructure.countDocuments(filter),
    ]);

    res.json({
      data: fees,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: skip + fees.length < total,
        hasPrev: page > 1,
      },
    });
  } catch (err) { next(err); }
}

async function getFeeByClass(req, res, next) {
  try {
    const { className } = req.params;
    const cached = get(KEYS.feeByClass(className));
    if (cached !== undefined) return res.json(cached);

    const fee = await FeeStructure.findOne({ schoolId: req.schoolId, className, deletedAt: null, isActive: true });
    if (!fee) return next(Object.assign(new Error(`No fee structure found for class ${className}`), { code: 'NOT_FOUND' }));
    set(KEYS.feeByClass(className), fee, TTL.FEES);
    res.json(fee);
  } catch (err) { next(err); }
}

async function deleteFeeStructure(req, res, next) {
  try {
    const { className } = req.params;
    const Student = require('../models/studentModel');
    const affectedCount = await Student.countDocuments({ schoolId: req.schoolId, class: className, feePaid: false, deletedAt: null });

    if (affectedCount > 0 && req.query.force !== 'true')
      return next(Object.assign(new Error(`${affectedCount} student(s) in class ${className} have unpaid fees. Use ?force=true to deactivate anyway.`), { code: 'CONFLICT', status: 409, details: { affectedCount } }));

    const fee = await FeeStructure.findOneAndUpdate({ schoolId: req.schoolId, className }, { isActive: false }, { new: true });
    if (!fee) return next(Object.assign(new Error('Fee structure not found'), { code: 'NOT_FOUND' }));

    if (affectedCount > 0) logger.warn('Fee structure deactivated with active obligations', { schoolId: req.schoolId, className, affectedStudents: affectedCount });
    del(KEYS.feesAll(), KEYS.feeByClass(className));
    await audit(req, 'fee_delete', className, { className, feeAmount: fee.feeAmount });
    res.json({ message: `Fee structure for class ${className} deactivated` });
  } catch (err) { next(err); }
}

async function updateFeeStructure(req, res, next) {
  try {
    const { className } = req.params;
    const { feeAmount, description, academicYear, paymentDeadline, cascadeToStudents } = req.body;
    if (feeAmount == null) return next(Object.assign(new Error('feeAmount is required'), { code: 'VALIDATION_ERROR' }));

    const updateFields = { feeAmount };
    if (description    !== undefined) updateFields.description    = description;
    if (academicYear   !== undefined) updateFields.academicYear   = academicYear;
    if (paymentDeadline !== undefined) updateFields.paymentDeadline = paymentDeadline;

    const fee = await FeeStructure.findOneAndUpdate({ schoolId: req.schoolId, className, isActive: true }, updateFields, { new: true, runValidators: true });
    if (!fee) return next(Object.assign(new Error(`No active fee structure found for class ${className}`), { code: 'NOT_FOUND' }));

    del(KEYS.feesAll(), KEYS.feeByClass(className));

    let studentsUpdated = 0;
    if (cascadeToStudents === true) {
      const Student = require('../models/studentModel');
      const Payment = require('../models/paymentModel');
      const StudentFeeHistory = require('../models/studentFeeHistoryModel');

      const session = await mongoose.connection.startSession({
        causalConsistency: true,
      });
      try {
        await session.withTransaction(async () => {
          const students = await Student.find({ schoolId: req.schoolId, class: className, deletedAt: null }).session(session);

          if (students.length > 0) {
            const studentIds = students.map(s => s.studentId);

            // Aggregate confirmed payment totals per student from authoritative source
            const paymentTotals = await Payment.aggregate([
              { $match: Payment.activeFilter({ schoolId: req.schoolId, studentId: { $in: studentIds }, status: 'SUCCESS' }) },
              { $group: { _id: '$studentId', amountPaid: { $sum: '$amount' } } },
            ]).session(session);

            const paidByStudentId = new Map(paymentTotals.map(p => [p._id, p.amountPaid]));

            const bulkOps = students.map(s => {
              const amountPaid = paidByStudentId.get(s.studentId) || 0;
              const remainingBalance = Math.max(0, feeAmount - amountPaid);
              return {
                updateOne: {
                  filter: { _id: s._id, schoolId: req.schoolId },
                  update: {
                    $set: {
                      feeAmount,
                      totalPaid: amountPaid,
                      remainingBalance,
                      feePaid: amountPaid >= feeAmount,
                    },
                  },
                },
              };
            });

            await Student.bulkWrite(bulkOps, { session, writeConcern: { w: 'majority' } });

            const historyDocs = students.map(s => {
              const amountPaid = paidByStudentId.get(s.studentId) || 0;
              const remainingBalance = Math.max(0, feeAmount - amountPaid);
              return {
                schoolId: req.schoolId,
                studentId: s.studentId,
                category: className,
                amount: feeAmount,
                paid: amountPaid >= feeAmount,
                totalPaid: amountPaid,
                remainingBalance,
              };
            });

            await StudentFeeHistory.insertMany(historyDocs, { session, writeConcern: { w: 'majority' } });
            studentsUpdated = students.length;
          }
        });
      } finally {
        session.endSession();
      }
    }

    await audit(req, 'fee_update', className, { className, feeAmount, cascadeToStudents, studentsUpdated });
    res.json({ fee, studentsUpdated });
  } catch (err) { next(err); }
}

module.exports = { createFeeStructure, getAllFeeStructures, getFeeByClass, deleteFeeStructure, updateFeeStructure };