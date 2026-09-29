'use strict';

/**
 * Academic Period Service (Issue #1569)
 *
 * Handles creation, retrieval, rollover, and period-scoped reporting for
 * AcademicPeriod and StudentPeriodFee documents.
 *
 * Rollover algorithm
 * ------------------
 * 1. Close the current period (isClosed = true, isCurrent = false).
 * 2. Create (or activate) the next period (isCurrent = true).
 * 3. For every student in the school:
 *    a. Read their StudentPeriodFee for the closing period.
 *    b. Compute arrears = Math.max(0, totalDue - totalPaid).
 *    c. Create a StudentPeriodFee for the new period, carrying arrears.
 *    d. Update the Student's top-level scalars to reflect the new period.
 * 4. Persist aggregate carriedForwardArrears on the new AcademicPeriod.
 * 5. Emit a logAudit event.
 *
 * All writes are wrapped in a MongoDB multi-document transaction so the
 * rollover is atomic.
 */

const mongoose = require('mongoose');
const AcademicPeriod = require('../models/academicPeriodModel');
const StudentPeriodFee = require('../models/studentPeriodFeeModel');
const FeeStructure = require('../models/feeStructureModel');
const Student = require('../models/studentModel');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger').child('AcademicPeriodService');

// ─────────────────────────────────────────────────────────────────────────────
// CRUD helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new academic period for a school.
 * @param {{ schoolId: string, name: string, startsAt: Date|string, endsAt: Date|string, notes?: string }} data
 * @returns {Promise<AcademicPeriod>}
 */
async function createPeriod({ schoolId, name, startsAt, endsAt, notes } = {}) {
  if (!schoolId || !name || !startsAt || !endsAt) {
    throw Object.assign(
      new Error('schoolId, name, startsAt and endsAt are required'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (start >= end) {
    throw Object.assign(
      new Error('startsAt must be before endsAt'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const period = await AcademicPeriod.create({
    schoolId,
    name,
    startsAt: start,
    endsAt: end,
    notes: notes || null,
  });

  logger.info('Academic period created', { schoolId, periodId: period._id, name });
  return period;
}

/**
 * List all academic periods for a school, newest first.
 * @param {string} schoolId
 * @returns {Promise<AcademicPeriod[]>}
 */
async function listPeriods(schoolId) {
  return AcademicPeriod.find({ schoolId }).sort({ startsAt: -1 }).lean();
}

/**
 * Get the current period for a school (isCurrent === true).
 * Returns null when no period has been designated current.
 * @param {string} schoolId
 * @returns {Promise<AcademicPeriod|null>}
 */
async function getCurrentPeriod(schoolId) {
  return AcademicPeriod.findOne({ schoolId, isCurrent: true }).lean();
}

/**
 * Get a single period by its _id.
 * @param {string} schoolId
 * @param {string} periodId
 * @returns {Promise<AcademicPeriod>}
 */
async function getPeriodById(schoolId, periodId) {
  const period = await AcademicPeriod.findOne({ _id: periodId, schoolId }).lean();
  if (!period) {
    throw Object.assign(new Error('Academic period not found'), { code: 'NOT_FOUND' });
  }
  return period;
}

/**
 * Update mutable metadata on a period (name, dates, notes).
 * Closed or current periods can only have their notes updated.
 * @param {string} schoolId
 * @param {string} periodId
 * @param {{ name?: string, startsAt?: Date, endsAt?: Date, notes?: string }} updates
 * @returns {Promise<AcademicPeriod>}
 */
async function updatePeriod(schoolId, periodId, updates = {}) {
  const period = await AcademicPeriod.findOne({ _id: periodId, schoolId });
  if (!period) {
    throw Object.assign(new Error('Academic period not found'), { code: 'NOT_FOUND' });
  }

  if (period.isClosed && (updates.name || updates.startsAt || updates.endsAt)) {
    throw Object.assign(
      new Error('Cannot change name or dates on a closed period'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  if (updates.name !== undefined) period.name = updates.name;
  if (updates.startsAt !== undefined) period.startsAt = new Date(updates.startsAt);
  if (updates.endsAt !== undefined) period.endsAt = new Date(updates.endsAt);
  if (updates.notes !== undefined) period.notes = updates.notes;

  if (period.startsAt >= period.endsAt) {
    throw Object.assign(
      new Error('startsAt must be before endsAt'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  await period.save();
  return period.toObject();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee assignment helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or update a StudentPeriodFee assignment for one student.
 * Used when registering a new student into an existing period or when an admin
 * manually adjusts a single student's fee for the period.
 *
 * @param {{ schoolId, studentId, periodId, feeAmount, paymentDeadline?, carriedArrears? }} data
 * @returns {Promise<StudentPeriodFee>}
 */
async function upsertStudentPeriodFee({
  schoolId,
  studentId,
  periodId,
  feeAmount,
  paymentDeadline = null,
  carriedArrears = 0,
} = {}) {
  const period = await AcademicPeriod.findOne({ _id: periodId, schoolId }).lean();
  if (!period) {
    throw Object.assign(new Error('Academic period not found'), { code: 'NOT_FOUND' });
  }
  if (period.isClosed) {
    throw Object.assign(
      new Error('Cannot assign fees to a closed academic period'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const totalDue = feeAmount + (carriedArrears || 0);
  const existing = await StudentPeriodFee.findOne({ schoolId, studentId, periodId });

  if (existing) {
    existing.feeAmount = feeAmount;
    existing.carriedArrears = carriedArrears || 0;
    existing.remainingBalance = Math.max(0, totalDue - existing.totalPaid);
    existing.feePaid = existing.totalPaid >= totalDue;
    if (paymentDeadline !== undefined) existing.paymentDeadline = paymentDeadline;
    await existing.save();
    return existing.toObject();
  }

  const assignment = await StudentPeriodFee.create({
    schoolId,
    studentId,
    periodId,
    periodName: period.name,
    feeAmount,
    carriedArrears: carriedArrears || 0,
    totalPaid: 0,
    remainingBalance: totalDue,
    feePaid: totalDue <= 0,
    paymentDeadline: paymentDeadline || null,
  });

  return assignment.toObject();
}

/**
 * Get a student's fee summary for a specific period.
 * @param {string} schoolId
 * @param {string} studentId
 * @param {string} periodId
 * @returns {Promise<StudentPeriodFee|null>}
 */
async function getStudentPeriodFee(schoolId, studentId, periodId) {
  return StudentPeriodFee.findOne({ schoolId, studentId, periodId }).lean();
}

/**
 * Get a student's fee summary across ALL periods.
 * Useful for the all-time arrears view.
 * @param {string} schoolId
 * @param {string} studentId
 * @returns {Promise<StudentPeriodFee[]>}
 */
async function getStudentAllPeriodFees(schoolId, studentId) {
  return StudentPeriodFee.find({ schoolId, studentId }).sort({ createdAt: 1 }).lean();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollover
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roll over from the current period to a new (or pre-created) period.
 *
 * Steps:
 *  1. Validate that there is a current period and the target period exists and is open.
 *  2. Within a MongoDB transaction:
 *     a. Close the current period.
 *     b. Mark the new period as current.
 *     c. For each student, compute arrears and create new period fee assignments.
 *     d. Persist aggregate arrears on the new period.
 *     e. Sync Student top-level scalars to the new period.
 *  3. Emit audit log.
 *
 * @param {{
 *   schoolId: string,
 *   nextPeriodId: string,
 *   performedBy: string,
 *   ipAddress?: string,
 *   userAgent?: string,
 * }} options
 * @returns {Promise<{ closedPeriod: object, newPeriod: object, studentsRolledOver: number, totalArrears: number }>}
 */
async function rolloverToNextPeriod({
  schoolId,
  nextPeriodId,
  performedBy,
  ipAddress = null,
  userAgent = null,
} = {}) {
  if (!schoolId || !nextPeriodId || !performedBy) {
    throw Object.assign(
      new Error('schoolId, nextPeriodId and performedBy are required'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  // Pre-flight checks outside transaction to give clear errors before taking a lock.
  const currentPeriod = await AcademicPeriod.findOne({ schoolId, isCurrent: true });
  if (!currentPeriod) {
    throw Object.assign(
      new Error('No current academic period found for this school'),
      { code: 'NOT_FOUND' }
    );
  }

  const nextPeriod = await AcademicPeriod.findOne({ _id: nextPeriodId, schoolId });
  if (!nextPeriod) {
    throw Object.assign(
      new Error('Target academic period not found'),
      { code: 'NOT_FOUND' }
    );
  }
  if (nextPeriod.isClosed) {
    throw Object.assign(
      new Error('Target period is already closed and cannot be made current'),
      { code: 'VALIDATION_ERROR' }
    );
  }
  if (String(nextPeriod._id) === String(currentPeriod._id)) {
    throw Object.assign(
      new Error('Target period is already the current period'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  // Fetch all active students for fee assignment.
  const students = await Student.find({ schoolId, deletedAt: null }).lean();
  // Fetch all fee structures (keyed by className) for the school.
  const feeStructures = await FeeStructure.find({ schoolId, isActive: true, deletedAt: null }).lean();
  const feeByClass = new Map(feeStructures.map(f => [f.className, f.feeAmount]));

  const session = await mongoose.connection.startSession();
  let studentsRolledOver = 0;
  let totalArrears = 0;

  try {
    await session.withTransaction(async () => {
      // 1. Close the current period.
      await AcademicPeriod.updateOne(
        { _id: currentPeriod._id },
        { $set: { isCurrent: false, isClosed: true } },
        { session }
      );

      // 2. Mark the next period as current.
      await AcademicPeriod.updateOne(
        { _id: nextPeriodId },
        { $set: { isCurrent: true } },
        { session }
      );

      // 3. Process each student.
      for (const student of students) {
        const existingAssignment = await StudentPeriodFee.findOne(
          { schoolId, studentId: student.studentId, periodId: currentPeriod._id },
          null,
          { session }
        ).lean();

        let arrears = 0;
        if (existingAssignment) {
          const totalDue = existingAssignment.feeAmount + (existingAssignment.carriedArrears || 0);
          arrears = Math.max(0, totalDue - (existingAssignment.totalPaid || 0));
        } else {
          // Student had no assignment in the closing period — treat outstanding fee as arrears.
          arrears = student.remainingBalance != null
            ? Math.max(0, student.remainingBalance)
            : 0;
        }

        totalArrears += arrears;

        // Determine the fee for the new period from the active fee structure.
        const newFeeAmount = feeByClass.get(student.class) ?? student.feeAmount;
        const totalDueNew = newFeeAmount + arrears;

        // Upsert the StudentPeriodFee for the new period.
        await StudentPeriodFee.updateOne(
          { schoolId, studentId: student.studentId, periodId: nextPeriodId },
          {
            $setOnInsert: { createdAt: new Date() },
            $set: {
              periodName: nextPeriod.name,
              feeAmount: newFeeAmount,
              carriedArrears: arrears,
              totalPaid: 0,
              remainingBalance: totalDueNew,
              feePaid: totalDueNew <= 0,
              updatedAt: new Date(),
            },
          },
          { upsert: true, session }
        );

        // 4. Sync the Student top-level scalars to reflect the new period.
        await Student.updateOne(
          { schoolId, studentId: student.studentId },
          {
            $set: {
              feeAmount: newFeeAmount,
              totalPaid: 0,
              remainingBalance: totalDueNew,
              feePaid: totalDueNew <= 0,
              academicYear: nextPeriod.name,
            },
          },
          { session }
        );

        studentsRolledOver++;
      }

      // 5. Store aggregate arrears on the new period.
      await AcademicPeriod.updateOne(
        { _id: nextPeriodId },
        { $set: { carriedForwardArrears: totalArrears } },
        { session }
      );
    });
  } finally {
    session.endSession();
  }

  // Audit log outside the transaction so a log failure doesn't undo the rollover.
  try {
    await logAudit({
      schoolId,
      action: 'academic_period_rollover',
      performedBy,
      targetId: String(nextPeriodId),
      targetType: 'academic_period',
      details: {
        closedPeriodId: String(currentPeriod._id),
        closedPeriodName: currentPeriod.name,
        newPeriodId: String(nextPeriodId),
        newPeriodName: nextPeriod.name,
        studentsRolledOver,
        totalArrears,
      },
      result: 'success',
      ipAddress,
      userAgent,
    });
  } catch (auditErr) {
    logger.warn('Audit log failed after rollover', { error: auditErr.message });
  }

  logger.info('Academic period rollover complete', {
    schoolId,
    closedPeriod: currentPeriod.name,
    newPeriod: nextPeriod.name,
    studentsRolledOver,
    totalArrears,
  });

  return {
    closedPeriod: { _id: String(currentPeriod._id), name: currentPeriod.name },
    newPeriod: { _id: String(nextPeriodId), name: nextPeriod.name },
    studentsRolledOver,
    totalArrears,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration helper: seed one default period per school from existing data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure every school has at least one AcademicPeriod that covers its existing
 * data.  Called by the migration script (032_seed_academic_periods.js).
 *
 * For each school that has no periods, creates a single period whose name
 * is derived from the earliest payment's year and marks it current.
 *
 * @returns {Promise<{ created: number }>}
 */
async function seedDefaultPeriodsForExistingSchools() {
  const School = require('../models/schoolModel');
  const schools = await School.find({ isActive: true }).lean();

  let created = 0;
  for (const school of schools) {
    const existing = await AcademicPeriod.findOne({ schoolId: school.schoolId });
    if (existing) continue;

    const year = new Date().getUTCFullYear();
    const name = `${year} Default Period`;

    await AcademicPeriod.create({
      schoolId: school.schoolId,
      name,
      startsAt: new Date(`${year}-01-01T00:00:00.000Z`),
      endsAt: new Date(`${year}-12-31T23:59:59.999Z`),
      isCurrent: true,
      notes: 'Auto-created during migration to cover existing data',
    });

    created++;
    logger.info('Seeded default academic period', { schoolId: school.schoolId, name });
  }

  return { created };
}

module.exports = {
  createPeriod,
  listPeriods,
  getCurrentPeriod,
  getPeriodById,
  updatePeriod,
  upsertStudentPeriodFee,
  getStudentPeriodFee,
  getStudentAllPeriodFees,
  rolloverToNextPeriod,
  seedDefaultPeriodsForExistingSchools,
};
