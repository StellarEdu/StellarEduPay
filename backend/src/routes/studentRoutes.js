'use strict';

const express = require('express');
const router = express.Router();
const {
  registerStudent,
  getAllStudents,
  getStudent,
  getPublicStudentInfo,
  updateStudent,
  deleteStudent,
  restoreStudent,
  getDeletedStudentPayments,
  getPaymentSummary,
  bulkImportStudents,
  getBulkImportTemplate,
  getOverdueStudents,
  resetPayment,
  reconcileStudent,
  getFeeHistory,
  exportStudents,
  adjustStudentCredit,
} = require('../controllers/studentController');
const { resubscribeReminders } = require('../controllers/reminderController');
const {
  validateRegisterStudent,
  validateStudentIdParam,
  validateGetAllStudentsQuery,
  validateExportStudentsQuery,
  validateGetStudentFeeHistoryQuery,
} = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { bulkImportLimiter, publicStudentLimiter } = require('../middleware/rateLimiter');
const streamingCsvUpload = require('../middleware/streamingCsvUpload');

router.use(resolveSchool);

// Staff+ can manage students (owner, staff)
router.post('/', requireSchoolAuth(['owner', 'staff']), validateRegisterStudent, auditContext, registerStudent);
router.post('/bulk', requireSchoolAuth(['owner', 'staff']), bulkImportLimiter, express.json({ limit: '1mb' }), streamingCsvUpload(), auditContext, bulkImportStudents);
router.get('/', requireSchoolAuth(['owner', 'staff', 'read_only']), validateGetAllStudentsQuery, getAllStudents);
router.get('/bulk/template.csv', requireSchoolAuth(['owner', 'staff', 'read_only']), getBulkImportTemplate);
router.get('/export', requireSchoolAuth(['owner', 'staff', 'read_only']), validateExportStudentsQuery, exportStudents);

// All authenticated users can view summaries
router.get('/summary', requireSchoolAuth(['owner', 'staff', 'read_only']), getPaymentSummary);
router.get('/overdue', requireSchoolAuth(['owner', 'staff', 'read_only']), getOverdueStudents);

// Public routes
router.get('/public/:studentId', publicStudentLimiter, validateStudentIdParam, getPublicStudentInfo);
router.get('/:studentId', requireAdminAuth, validateStudentIdParam, getStudent);
// updateStudent performs a partial update, so PATCH is the accurate verb (issue
// #1576); PUT is kept as an alias since the frontend previously relied on it.
router.patch('/:studentId', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, updateStudent);
router.put('/:studentId', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, updateStudent);
router.delete('/:studentId', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, deleteStudent);
router.post('/:studentId/restore', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, restoreStudent);
router.get('/:studentId/payments/audit', requireSchoolAuth(['owner', 'staff', 'read_only']), validateStudentIdParam, getDeletedStudentPayments);
router.post('/:studentId/reset-payment', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, resetPayment);
router.post('/:studentId/reconcile', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, reconcileStudent);
router.post('/:studentId/reminders/resubscribe', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, resubscribeReminders);
router.get('/:studentId/fee-history', requireSchoolAuth(['owner', 'staff', 'read_only']), validateStudentIdParam, validateGetStudentFeeHistoryQuery, getFeeHistory);
router.post('/:studentId/credit-adjustments', requireSchoolAuth(['owner', 'staff']), validateStudentIdParam, auditContext, adjustStudentCredit);

module.exports = router;
