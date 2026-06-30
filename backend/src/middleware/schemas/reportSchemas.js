'use strict';

const Joi = require('joi');

const MAX_RANGE_DAYS = parseInt(process.env.REPORT_MAX_RANGE_DAYS || '366', 10);

/**
 * #884 — Versioned export schema.
 * format: 'json' | 'csv' (legacy)  | 'accounting_csv' (versioned, accounting-friendly)
 * schema_version: only meaningful for accounting_csv; defaults to 1 (current).
 */
const reportQuerySchema = Joi.object({
  startDate:      Joi.string().isoDate().optional(),
  endDate:        Joi.string().isoDate().optional(),
  format:         Joi.string().valid('json', 'csv', 'accounting_csv').default('json'),
  schema_version: Joi.number().integer().min(1).max(1).default(1),
  async:          Joi.boolean().optional(),
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
      return helpers.error('any.invalid', { message: `Date range exceeds the maximum of ${MAX_RANGE_DAYS} days` });
    }
  }
  return value;
}).messages({ 'any.invalid': '{{#message}}' });

module.exports = { reportQuerySchema, MAX_RANGE_DAYS };
