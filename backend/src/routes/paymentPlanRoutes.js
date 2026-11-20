'use strict';

const express = require('express');
const router = express.Router();
const {
  createPaymentPlan,
  getPaymentPlan,
  updateInstallmentStatus,
  cancelPaymentPlan,
} = require('../controllers/paymentPlanController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { validateStudentIdParam, validateInstallmentIndexParam } = require('../middleware/validate');

router.use(resolveSchool);

router.post('/:studentId', requireAdminAuth, auditContext, validateStudentIdParam, createPaymentPlan);
router.get('/:studentId', validateStudentIdParam, requireSchoolAuth(), getPaymentPlan);
router.patch('/:studentId/installment/:installmentIndex', requireAdminAuth, auditContext, validateStudentIdParam, validateInstallmentIndexParam, updateInstallmentStatus);
router.delete('/:studentId', requireAdminAuth, auditContext, validateStudentIdParam, cancelPaymentPlan);

module.exports = router;