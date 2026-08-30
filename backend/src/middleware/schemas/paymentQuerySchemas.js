'use strict';

/**
 * Joi schemas for payment query endpoints.
 *
 * Issue #70: Enforces pagination bounds (max page size 100).
 * Issue #1377: Validates the feeCategory query parameter so an unsanitized
 *              value never reaches a payment/student lookup.
 * Issue #71: Caps date ranges, validates dates, and ensures no user-supplied
 *            free-text reaches a MongoDB $regex — all filter values are either
 *            strictly typed or validated against an enum so the DB never
 *            receives an attacker-controlled regex pattern.
 */

const Joi = require('joi');

const MAX_RANGE_DAYS = parseInt(process.env.REPORT_MAX_RANGE_DAYS || '366', 10);

// ── Shared pagination fields ─────────────────────────────────────────────────
const paginationFields = {
  page:  Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
};

// ── Helper: reusable date pair with range cap ────────────────────────────────
function datePair() {
  return {
    startDate: Joi.string().isoDate().optional(),
    endDate:   Joi.string().isoDate().optional(),
  };
}

// ── getAllPayments query schema ───────────────────────────────────────────────
const getAllPaymentsSchema = Joi.object({
  ...paginationFields,
  ...datePair(),
  // Amount filters — must be finite numbers, not free-text
  minAmount: Joi.number().min(0).optional(),
  maxAmount: Joi.number().min(0).optional(),
  // Status must match the Payment model enum — prevents regex injection
  status: Joi.string()
    .valid('PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'REFUNDED', 'INVALID')
    .uppercase()
    .optional(),
  // studentId is a structured alphanumeric ID — never used as a regex pattern
  studentId: Joi.string().max(100).optional(),
  isSuspicious: Joi.boolean().truthy('true').falsy('false').optional(),
}).custom((value, helpers) => {
  const { startDate, endDate } = value;
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end   = new Date(endDate);
    if (start > end) {
      return helpers.error('any.invalid', { message: 'startDate must be before or equal to endDate' });
    }
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    if (diffDays > MAX_RANGE_DAYS) {
      return helpers.error('any.invalid', {
        message: `Date range exceeds the maximum of ${MAX_RANGE_DAYS} days`,
      });
    }
  }
  return value;
}).messages({ 'any.invalid': '{{#message}}' });

// ── getPaymentInstructions query schema ──────────────────────────────────────
// feeCategory is matched against Student.fees[].category and Payment.feeCategory.
// Constraining it to the character set those values actually use keeps a
// malformed value from reaching a query and keeps fee-structure naming out of
// Mongo cast-error messages. Other query params (asset) are validated in the
// controller, so unknown keys pass through untouched.
const FEE_CATEGORY_RE = /^[A-Za-z0-9_-]+$/;

const getPaymentInstructionsQuerySchema = Joi.object({
  feeCategory: Joi.string()
    .max(100)
    .pattern(FEE_CATEGORY_RE)
    .optional()
    .messages({
      'string.pattern.base': 'feeCategory may only contain letters, numbers, underscores and hyphens',
      'string.max': 'feeCategory must be at most 100 characters',
      'string.empty': 'feeCategory must not be empty',
    }),
}).unknown(true);

// ── getSuspiciousPayments query schema ───────────────────────────────────────
const getSuspiciousPaymentsSchema = Joi.object({
  ...paginationFields,
});

// ── getRetryQueue query schema ───────────────────────────────────────────────
const getRetryQueueSchema = Joi.object({
  ...paginationFields,
});

// ── getOverpayments / getPendingPayments / getStudentPayments ─────────────────
const paginationOnlySchema = Joi.object({
  ...paginationFields,
});

module.exports = {
  getAllPaymentsSchema,
  getPaymentInstructionsQuerySchema,
  FEE_CATEGORY_RE,
  getSuspiciousPaymentsSchema,
  getRetryQueueSchema,
  paginationOnlySchema,
  MAX_RANGE_DAYS,
};
