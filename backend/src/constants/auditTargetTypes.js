'use strict';

/**
 * Canonical audit target types — Issue #1999.
 *
 * Single source of truth for `AuditLog.targetType`. Every logAudit call site
 * must use one of these values; the model enum and the schema validation are
 * both derived from this list so an unknown value can never be silently
 * dropped by Mongoose validation.
 *
 * Values are normalised to snake_case (e.g. `academic_period`, not
 * `academicPeriod`).
 */
const AUDIT_TARGET_TYPES = Object.freeze([
  'student',
  'payment',
  'fee',
  'school',
  'user',
  'webhook',
  'auth',
  'session',
  'academic_period',
  'system_config',
  'payment_job',
  'dispute',
  'email_address',
  'fee_adjustment_rule',
  'outbox_event',
  'payment_limits',
  'payment_plan',
  'retry_job',
  'retry_queue',
  'source_validation_rule',
]);

module.exports = { AUDIT_TARGET_TYPES };
