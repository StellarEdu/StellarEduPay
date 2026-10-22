'use strict';

const Joi = require('joi');

const {
  createPaymentIntentSchema,
  submitTransactionSchema,
  verifyPaymentSchema,
} = require('./schemas/paymentSchemas');

const {
  getPaymentInstructionsQuerySchema,
} = require('./schemas/paymentQuerySchemas');

const {
  getAllStudentsQuerySchema,
  exportStudentsQuerySchema,
  getStudentFeeHistoryQuerySchema,
} = require('./schemas/studentQuerySchemas');

const {
  setPasswordSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  updateSchoolUserSchema,
} = require('./schemas/accountSchemas');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      convert:    true,
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field:   detail.context?.key || detail.path.join('.') || 'unknown',
        message: detail.message,
      }));
      return res.status(400).json({ errors });
    }

    req[source] = value;
    return next();
  };
}

const validateCreatePaymentIntent = validate(createPaymentIntentSchema, 'body');
const validateSubmitTransaction = validate(submitTransactionSchema, 'body');
const validateVerifyPayment = validate(verifyPaymentSchema, 'body');

// Issue #1776: unauthenticated credential endpoints must validate bodies so
// non-string input (e.g. {"email": {"a":1}}) cannot reach the controllers.
const validateSetPassword = validate(setPasswordSchema, 'body');
const validateRequestPasswordReset = validate(requestPasswordResetSchema, 'body');
const validateResetPassword = validate(resetPasswordSchema, 'body');

// Issue #1772: validate school-user updates (roles / isActive).
const validateUpdateSchoolUser = validate(updateSchoolUserSchema, 'body');

const STUDENT_ID_RE = /^[\w-]{1,28}$/;

// Issue #1543: names are interpolated into parent-facing emails and exports.
// Normalise them and reject control characters / absurd lengths on input.
const NAME_MAX_LENGTH = 100;
const CLASS_MAX_LENGTH = 50;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

function normaliseName(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
}

function nameError(field, value, maxLength) {
  if (!value) return `${field} is required`;
  if (value.length > maxLength) return `${field} must not exceed ${maxLength} characters`;
  if (CONTROL_CHARS_RE.test(value)) return `${field} must not contain control characters`;
  return null;
}

function validStudentId(id) {
  return typeof id === 'string' && STUDENT_ID_RE.test(id);
}

function validPositiveNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0;
}

function validTxHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
}

/** Middleware: validate :studentId URL param */
function validateStudentIdParam(req, res, next) {
  const { studentId } = req.params;
  if (typeof studentId !== 'string' || !STUDENT_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'Invalid studentId format', code: 'VALIDATION_ERROR' });
  }
  return next();
}

/** Middleware: validate the query string of GET /payments/instructions/:studentId */
function validatePaymentInstructionsQuery(req, res, next) {
  const { error, value } = getPaymentInstructionsQuerySchema.validate(req.query, {
    abortEarly: false,
    convert:    true,
  });

  if (error) {
    return res.status(400).json({
      error: error.details[0].message,
      code:  'VALIDATION_ERROR',
      errors: error.details.map(detail => ({
        field:   detail.context?.key || detail.path.join('.') || 'unknown',
        message: detail.message,
      })),
    });
  }

  req.query = value;
  return next();
}

/** Middleware: validate :txHash URL param */
function validateTxHashParam(req, res, next) {
  if (!validTxHash(req.params.txHash)) {
    return res.status(400).json({ errors: [{ field: 'txHash', message: 'Invalid txHash format' }] });
  }
  return next();
}

/** Middleware: validate POST /api/students body */
function validateRegisterStudent(req, res, next) {
  const errors = [];
  const body = req.body || {};

  // studentId — optional (auto-generated if absent), but must be valid if provided
  let studentId = body.studentId != null ? String(body.studentId).trim() : undefined;
  if (studentId !== undefined && !validStudentId(studentId)) {
    errors.push({ field: 'studentId', message: 'studentId must be 3–20 alphanumeric/dash/underscore characters' });
  }

  // name — required, normalised, length/control-character checked
  const name = normaliseName(body.name);
  const nameMsg = nameError('name', name, NAME_MAX_LENGTH);
  if (nameMsg) errors.push({ field: 'name', message: nameMsg });

  // class — required, normalised, length/control-character checked
  const className = normaliseName(body.class);
  const classMsg = nameError('class', className, CLASS_MAX_LENGTH);
  if (classMsg) errors.push({ field: 'class', message: classMsg });

  // feeAmount — optional, but must be positive number if provided
  let feeAmount = body.feeAmount;
  if (feeAmount != null) {
    feeAmount = Number(feeAmount);
    if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
      errors.push({ field: 'feeAmount', message: 'feeAmount must be a positive number' });
    }
  }

  if (errors.length) return res.status(400).json({ errors });

  // Write sanitized values back so the controller uses clean data
  req.body = { ...body, name, class: className };
  if (studentId !== undefined) req.body.studentId = studentId;
  if (feeAmount != null) req.body.feeAmount = feeAmount;

  return next();
}

function validateFeeStructure(req, res, next) {
  const { className, feeAmount } = req.body;
  const errors = [];

  if (!className || typeof className !== 'string' || !className.trim()) errors.push('className is required');
  if (!validPositiveNumber(feeAmount)) errors.push('feeAmount must be a positive number');

  if (errors.length) return res.status(400).json({ errors });
  return next();
}

function validateGetAllStudentsQuery(req, res, next) {
  const { error, value } = getAllStudentsQuerySchema.validate(req.query, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    return res.status(400).json({
      error: error.details[0].message,
      code: 'VALIDATION_ERROR',
      errors: error.details.map(detail => ({
        field: detail.context?.key || detail.path.join('.') || 'unknown',
        message: detail.message,
      })),
    });
  }

  req.query = value;
  return next();
}

function validateExportStudentsQuery(req, res, next) {
  const { error, value } = exportStudentsQuerySchema.validate(req.query, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    return res.status(400).json({
      error: error.details[0].message,
      code: 'VALIDATION_ERROR',
      errors: error.details.map(detail => ({
        field: detail.context?.key || detail.path.join('.') || 'unknown',
        message: detail.message,
      })),
    });
  }

  req.query = value;
  return next();
}

function validateGetStudentFeeHistoryQuery(req, res, next) {
  const { error, value } = getStudentFeeHistoryQuerySchema.validate(req.query, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    return res.status(400).json({
      error: error.details[0].message,
      code: 'VALIDATION_ERROR',
      errors: error.details.map(detail => ({
        field: detail.context?.key || detail.path.join('.') || 'unknown',
        message: detail.message,
      })),
    });
  }

  req.query = value;
  return next();
}

module.exports = {
  validate,
  normaliseName,
  nameError,
  NAME_MAX_LENGTH,
  CLASS_MAX_LENGTH,
  validateCreatePaymentIntent,
  validateSubmitTransaction,
  validateVerifyPayment,
  validateSetPassword,
  validateRequestPasswordReset,
  validateResetPassword,
  validateUpdateSchoolUser,
  validateStudentIdParam,
  validatePaymentInstructionsQuery,
  validateTxHashParam,
  validateRegisterStudent,
  validateFeeStructure,
  validateGetAllStudentsQuery,
  validateExportStudentsQuery,
  validateGetStudentFeeHistoryQuery,
};
