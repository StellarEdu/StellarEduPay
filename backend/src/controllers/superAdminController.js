'use strict';

const School = require('../models/schoolModel');
const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const { logAudit } = require('../services/auditService');

// GET /api/superadmin/schools — every school, active or not, for platform operators.
async function listSchools(req, res, next) {
  try {
    const schools = await School.find().sort({ name: 1 }).lean();
    res.json({ schools, count: schools.length });
  } catch (err) {
    next(err);
  }
}

// GET /api/superadmin/metrics — cross-school operational metrics.
async function getMetrics(req, res, next) {
  try {
    const [schoolCount, activeSchoolCount, studentCount, paymentAgg] = await Promise.all([
      School.countDocuments(),
      School.countDocuments({ isActive: true }),
      Student.countDocuments({ deletedAt: null }),
      Payment.aggregate([
        { $match: { status: 'SUCCESS', deletedAt: null } },
        { $group: { _id: '$schoolId', totalVolume: { $sum: '$amount' }, paymentCount: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      schools: { total: schoolCount, active: activeSchoolCount },
      students: { total: studentCount },
      payments: {
        totalVolume: paymentAgg.reduce((sum, r) => sum + r.totalVolume, 0),
        totalCount: paymentAgg.reduce((sum, r) => sum + r.paymentCount, 0),
        bySchool: paymentAgg.map((r) => ({ schoolId: r._id, totalVolume: r.totalVolume, paymentCount: r.paymentCount })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/superadmin/schools/:schoolId/quota — adjust a school's student quota.
async function updateQuota(req, res, next) {
  try {
    const { maxStudents } = req.body;
    if (typeof maxStudents !== 'number' || maxStudents < 1) {
      return res.status(400).json({ error: 'maxStudents must be a number >= 1', code: 'VALIDATION_ERROR' });
    }

    const school = await School.findOneAndUpdate(
      { schoolId: req.params.schoolId },
      { maxStudents },
      { new: true, runValidators: true }
    );
    if (!school) {
      return res.status(404).json({ error: 'School not found', code: 'NOT_FOUND' });
    }

    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: 'superadmin_quota_update',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { maxStudents },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json(school);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const validationErrors = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ errors: validationErrors, code: 'VALIDATION_ERROR' });
    }
    next(err);
  }
}

module.exports = { listSchools, getMetrics, updateQuota };
