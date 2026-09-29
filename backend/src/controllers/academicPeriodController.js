'use strict';

/**
 * Academic Period Controller (Issue #1569)
 *
 * Exposes CRUD endpoints for AcademicPeriod and the term rollover action.
 * Also provides per-period report filtering by delegating to reportService.
 */

const {
  createPeriod,
  listPeriods,
  getCurrentPeriod,
  getPeriodById,
  updatePeriod,
  upsertStudentPeriodFee,
  getStudentPeriodFee,
  getStudentAllPeriodFees,
  rolloverToNextPeriod,
} = require('../services/academicPeriodService');
const { generateReport, aggregateByDate } = require('../services/reportService');
const AcademicPeriod = require('../models/academicPeriodModel');

// ── Periods ────────────────────────────────────────────────────────────────────

async function createAcademicPeriod(req, res, next) {
  try {
    const { name, startsAt, endsAt, notes } = req.body;
    const period = await createPeriod({ schoolId: req.schoolId, name, startsAt, endsAt, notes });
    res.status(201).json(period);
  } catch (err) { next(err); }
}

async function listAcademicPeriods(req, res, next) {
  try {
    const periods = await listPeriods(req.schoolId);
    res.json({ data: periods, count: periods.length });
  } catch (err) { next(err); }
}

async function getAcademicPeriod(req, res, next) {
  try {
    const period = await getPeriodById(req.schoolId, req.params.periodId);
    res.json(period);
  } catch (err) { next(err); }
}

async function updateAcademicPeriod(req, res, next) {
  try {
    const { name, startsAt, endsAt, notes } = req.body;
    const period = await updatePeriod(req.schoolId, req.params.periodId, { name, startsAt, endsAt, notes });
    res.json(period);
  } catch (err) { next(err); }
}

async function getCurrentAcademicPeriod(req, res, next) {
  try {
    const period = await getCurrentPeriod(req.schoolId);
    if (!period) {
      return res.status(404).json({ error: 'No current academic period set', code: 'NOT_FOUND' });
    }
    res.json(period);
  } catch (err) { next(err); }
}

// ── Rollover ────────────────────────────────────────────────────────────────────

async function performRollover(req, res, next) {
  try {
    const { nextPeriodId } = req.body;
    if (!nextPeriodId) {
      return res.status(400).json({ error: 'nextPeriodId is required', code: 'VALIDATION_ERROR' });
    }

    const result = await rolloverToNextPeriod({
      schoolId: req.schoolId,
      nextPeriodId,
      performedBy: req.admin?.adminId || req.admin?.id || 'unknown',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    res.json(result);
  } catch (err) { next(err); }
}

// ── Student period fee assignment ─────────────────────────────────────────────

async function assignStudentPeriodFee(req, res, next) {
  try {
    const { studentId, periodId, feeAmount, paymentDeadline, carriedArrears } = req.body;
    if (!studentId || !periodId || feeAmount == null) {
      return res.status(400).json({ error: 'studentId, periodId and feeAmount are required', code: 'VALIDATION_ERROR' });
    }

    const assignment = await upsertStudentPeriodFee({
      schoolId: req.schoolId,
      studentId,
      periodId,
      feeAmount,
      paymentDeadline: paymentDeadline || null,
      carriedArrears: carriedArrears || 0,
    });

    res.status(200).json(assignment);
  } catch (err) { next(err); }
}

async function getStudentFeeForPeriod(req, res, next) {
  try {
    const { studentId, periodId } = req.params;
    const assignment = await getStudentPeriodFee(req.schoolId, studentId, periodId);
    if (!assignment) {
      return res.status(404).json({ error: 'No fee assignment found', code: 'NOT_FOUND' });
    }
    res.json(assignment);
  } catch (err) { next(err); }
}

async function getStudentAllFees(req, res, next) {
  try {
    const { studentId } = req.params;
    const fees = await getStudentAllPeriodFees(req.schoolId, studentId);
    res.json({ data: fees, count: fees.length });
  } catch (err) { next(err); }
}

// ── Period-scoped report ────────────────────────────────────────────────────────

async function getPeriodReport(req, res, next) {
  try {
    const { periodId } = req.params;
    const period = await getPeriodById(req.schoolId, periodId);
    const School = require('../models/schoolModel');
    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const timezone = school?.timezone || 'UTC';

    // Use the period's date range as the report filter.
    const startDate = period.startsAt.toISOString().slice(0, 10);
    const endDate = period.endsAt.toISOString().slice(0, 10);

    const report = await generateReport({
      schoolId: req.schoolId,
      startDate,
      endDate,
      timezone,
    });

    res.json({ period, report });
  } catch (err) { next(err); }
}

module.exports = {
  createAcademicPeriod,
  listAcademicPeriods,
  getAcademicPeriod,
  updateAcademicPeriod,
  getCurrentAcademicPeriod,
  performRollover,
  assignStudentPeriodFee,
  getStudentFeeForPeriod,
  getStudentAllFees,
  getPeriodReport,
};
