'use strict';

const express = require('express');
const router  = express.Router();
const Joi     = require('joi');

const { flagDispute, getDisputes, getDisputeById, resolveDispute, addEvidence } = require('../controllers/dispute.controller');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const EVIDENCE_TYPES = ['screenshot', 'tx_reference', 'document', 'other'];

const evidenceItemSchema = Joi.object({
  type: Joi.string().valid(...EVIDENCE_TYPES).required(),
  url: Joi.string().uri({ scheme: ['https'] }).max(2048).required(),
  description: Joi.string().max(500).allow('', null),
}).unknown(false);

const evidenceSchema = Joi.object({
  evidence: Joi.array().items(evidenceItemSchema).min(1).max(10).required(),
}).unknown(false);

const flagDisputeSchema = Joi.object({
  paymentId: Joi.string().trim().required(),
  reason: Joi.string().max(1000).allow('', null),
  evidence: Joi.array().items(evidenceItemSchema).max(10),
}).unknown(false);

// ---------------------------------------------------------------------------
// Validation middleware
// ---------------------------------------------------------------------------

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: false,
      convert: true,
    });
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map((d) => d.message),
      });
    }
    req.body = value;
    return next();
  };
}

// All dispute routes require school context
router.use(resolveSchool);

// Staff+ can flag and view disputes
router.post('/',        requireSchoolAuth(['owner', 'staff']), auditContext, validate(flagDisputeSchema), flagDispute);
router.get('/',         requireSchoolAuth(['owner', 'staff', 'read_only']), getDisputes);
router.get('/:id',      requireSchoolAuth(['owner', 'staff', 'read_only']), getDisputeById);

// Only owner/staff can resolve disputes
router.patch('/:id/resolve', requireSchoolAuth(['owner', 'staff']), auditContext, resolveDispute);
router.post('/:id/evidence', requireSchoolAuth(['owner', 'staff']), auditContext, validate(evidenceSchema), addEvidence);

module.exports = router;