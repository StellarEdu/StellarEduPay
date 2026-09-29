'use strict';

/**
 * Academic Period Routes (Issue #1569)
 *
 * All routes require school context. Mutation routes are restricted to school owners.
 *
 * GET    /api/academic-periods              — list all periods for the school
 * GET    /api/academic-periods/current      — get the currently active period
 * POST   /api/academic-periods              — create a new period
 * GET    /api/academic-periods/:periodId    — get a specific period
 * PUT    /api/academic-periods/:periodId    — update period metadata
 * POST   /api/academic-periods/rollover     — roll over to the next period
 * GET    /api/academic-periods/:periodId/report — period-scoped payment report
 *
 * Student fee assignment:
 * POST   /api/academic-periods/student-fees            — assign/update a student's fee for a period
 * GET    /api/academic-periods/student-fees/:studentId — all fee assignments for a student
 * GET    /api/academic-periods/:periodId/student-fees/:studentId — specific assignment
 */

const express = require('express');
const router = express.Router();

const {
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
} = require('../controllers/academicPeriodController');

const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

router.use(resolveSchool);

// ── Period CRUD ───────────────────────────────────────────────────────────────
router.get('/',          requireSchoolAuth(['owner', 'staff', 'read_only']), listAcademicPeriods);
router.get('/current',   requireSchoolAuth(['owner', 'staff', 'read_only']), getCurrentAcademicPeriod);
router.post('/',         requireSchoolAuth(['owner']), auditContext, createAcademicPeriod);

// ── Rollover action — owner-only, destructive ─────────────────────────────────
router.post('/rollover', requireSchoolAuth(['owner']), auditContext, performRollover);

// ── Student fee assignments ───────────────────────────────────────────────────
router.post('/student-fees',                     requireSchoolAuth(['owner', 'staff']), auditContext, assignStudentPeriodFee);
router.get('/student-fees/:studentId',           requireSchoolAuth(['owner', 'staff', 'read_only']), getStudentAllFees);

// ── Period-specific routes (must come after the non-parameterised ones) ────────
router.get('/:periodId',                         requireSchoolAuth(['owner', 'staff', 'read_only']), getAcademicPeriod);
router.put('/:periodId',                         requireSchoolAuth(['owner']), auditContext, updateAcademicPeriod);
router.get('/:periodId/report',                  requireSchoolAuth(['owner', 'staff', 'read_only']), getPeriodReport);
router.get('/:periodId/student-fees/:studentId', requireSchoolAuth(['owner', 'staff', 'read_only']), getStudentFeeForPeriod);

module.exports = router;
