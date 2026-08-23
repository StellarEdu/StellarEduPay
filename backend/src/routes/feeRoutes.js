'use strict';

const express = require('express');
const router = express.Router();
const { createFeeStructure, getAllFeeStructures, getFeeByClass, deleteFeeStructure, updateFeeStructure } = require('../controllers/feeController');
const { validateFeeStructure } = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All fee routes require school context
router.use(resolveSchool);

const requireIncludeDeletedAccess = (req, res, next) => {
  if (String(req.query.includeDeleted).toLowerCase() === 'true') {
    return requireAdminAuth(req, res, next);
  }
  return next();
};

router.post('/',              requireAdminAuth, auditContext, validateFeeStructure, createFeeStructure);
// Fee structures are tenant financial data: the base list requires a
// school-scoped JWT; includeDeleted additionally requires super-admin.
router.get('/',               requireSchoolAuth(), requireIncludeDeletedAccess, getAllFeeStructures);
router.get('/:className',     requireSchoolAuth(), getFeeByClass);
router.put('/:className',     requireAdminAuth, auditContext, validateFeeStructure, updateFeeStructure);
router.delete('/:className',  requireAdminAuth, auditContext, deleteFeeStructure);

module.exports = router;
