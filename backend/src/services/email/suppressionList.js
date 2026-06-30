'use strict';

/**
 * Email suppression list operations (Issue #80).
 *
 * Honoured by sendEmail() before every send, and fed by the provider bounce/
 * complaint webhooks. A hard bounce or complaint also flips the matching
 * student's reminderOptOut so the reminder pipeline stops targeting the address
 * (Issue #9 opt-out integration).
 */

const EmailSuppression = require('../../models/emailSuppressionModel');
const logger = require('../../utils/logger').child('EmailSuppression');

function normalize(email) {
  return (email || '').trim().toLowerCase();
}

/**
 * Is this address currently blocked from delivery?
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function isSuppressed(email) {
  const addr = normalize(email);
  if (!addr) return false;
  const record = await EmailSuppression.findOne({ email: addr }).lean();
  if (!record) return false;
  // Soft bounces are recorded but do not block.
  if (record.reason === 'bounce' && record.bounceType === 'soft') return false;
  return true;
}

/**
 * Add or update a suppression record. Blocking reasons also opt the student out
 * of reminders so we stop generating sends to a dead/abusive address.
 *
 * @param {string} email
 * @param {{reason: string, bounceType?: string, source?: string, detail?: string}} opts
 */
async function suppress(email, { reason, bounceType = null, source = null, detail = null } = {}) {
  const addr = normalize(email);
  if (!addr) return null;

  const record = await EmailSuppression.findOneAndUpdate(
    { email: addr },
    { $set: { reason, bounceType, source, detail, suppressedAt: new Date() } },
    { upsert: true, new: true }
  );

  const blocking = reason !== 'bounce' || bounceType === 'hard';
  if (blocking) {
    await _optOutStudents(addr, reason);
    logger.warn('Address suppressed', { email: addr, reason, bounceType, source });
  } else {
    logger.info('Soft bounce recorded (not blocking)', { email: addr, source });
  }
  return record;
}

async function recordBounce(email, { bounceType = 'hard', source = null, detail = null } = {}) {
  return suppress(email, { reason: 'bounce', bounceType, source, detail });
}

async function recordComplaint(email, { source = null, detail = null } = {}) {
  return suppress(email, { reason: 'complaint', source, detail });
}

/**
 * Remove a suppression (e.g. operator clears a stale bounce, or a parent
 * resubscribes). Does not automatically re-enable reminders.
 */
async function remove(email) {
  const addr = normalize(email);
  if (!addr) return false;
  const res = await EmailSuppression.deleteOne({ email: addr });
  return res.deletedCount > 0;
}

/** Paginated listing for the admin/operator view. */
async function list({ limit = 50, skip = 0 } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const cappedSkip = Math.max(parseInt(skip, 10) || 0, 0);
  const [items, total] = await Promise.all([
    EmailSuppression.find({}).sort({ suppressedAt: -1 }).skip(cappedSkip).limit(cappedLimit).lean(),
    EmailSuppression.countDocuments({}),
  ]);
  return { items, total, limit: cappedLimit, skip: cappedSkip };
}

/**
 * Opt out any student whose contact/parent email matches a now-suppressed
 * address. Best-effort: failures are logged, never thrown back to the caller.
 */
async function _optOutStudents(addr, reason) {
  try {
    const Student = require('../../models/studentModel');
    // Cross-school infrastructure op: a suppressed address may belong to any
    // tenant, so we bypass tenant scoping (the address itself is the scope).
    const res = await Student.updateMany(
      { $or: [{ parentEmail: addr }, { contactEmail: addr }], reminderOptOut: { $ne: true } },
      { $set: { reminderOptOut: true } },
      { _bypassTenantScope: true }
    );
    const modified = res?.modifiedCount ?? res?.nModified ?? 0;
    if (modified > 0) {
      logger.info('Opted out students after suppression', { email: addr, reason, modified });
    }
  } catch (err) {
    logger.error('Failed to opt out students after suppression', { email: addr, error: err.message });
  }
}

module.exports = {
  isSuppressed,
  suppress,
  recordBounce,
  recordComplaint,
  remove,
  list,
  normalize,
};
