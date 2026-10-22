'use strict';

/**
 * disputeNotificationService.js — Issue #1638.
 *
 * Disputes are the main trust-recovery mechanism for a payment that was not
 * credited, so the people involved must hear about them:
 *
 *   Raiser   — confirmation with a reference on creation, and an update on every
 *              status change (under review, resolved, rejected, reopened). Sent
 *              to dispute.raisedByEmail / raisedByPhone, falling back to the
 *              student's parent contact.
 *   Admins   — alerted when a dispute is raised and when an open dispute
 *              breaches its SLA. Sent to the school's contact/admin email and
 *              its active owner/staff users.
 *
 * The SLA sweep (startDisputeSlaScheduler, leader-only) marks open disputes
 * past their slaDeadline as breached, alerts admins once per dispute, emits a
 * `dispute.sla_breached` webhook + SSE event and refreshes the dispute gauges.
 *
 * Every function here is best-effort: notification failures are logged and
 * never fail the dispute operation that triggered them.
 */

const Dispute = require('../models/disputeModel');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');
const User = require('../models/userModel');
const { sendEmail } = require('./email');
const { sendSms, isValidE164 } = require('./smsService');
const { renderEmailTemplate } = require('../utils/templateRenderer');
const logger = require('../utils/logger').child('DisputeNotification');

const SLA_SWEEP_INTERVAL_MS = parseInt(process.env.DISPUTE_SLA_SWEEP_INTERVAL_MS, 10) || 15 * 60 * 1000;
const SLA_SWEEP_BATCH = 100;

const ADMIN_ROLES = ['owner', 'staff'];

const STATUS_LABELS = {
  open: 'Open',
  under_review: 'Under review',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

/**
 * Raiser-facing copy per notification kind.
 * `kind` is 'created' or the dispute's new status ('reopened' for open again).
 */
const RAISER_COPY = {
  created: {
    subject: (ref) => `We received your payment dispute (${ref})`,
    message: 'We have received your dispute about the payment below. Our team will review it and keep you updated. Please quote the reference in any correspondence about this dispute.',
  },
  under_review: {
    subject: (ref) => `Your payment dispute is under review (${ref})`,
    message: 'Your dispute is now being reviewed by the school.',
  },
  resolved: {
    subject: (ref) => `Your payment dispute has been resolved (${ref})`,
    message: 'Your dispute has been resolved in your favour. The payment has been marked for refund; the school will contact you about the refund if anything further is needed.',
  },
  rejected: {
    subject: (ref) => `Your payment dispute has been closed (${ref})`,
    message: 'After review, the school has closed your dispute and the original payment record stands. See the note below for details.',
  },
  reopened: {
    subject: (ref) => `Your payment dispute has been reopened (${ref})`,
    message: 'Your dispute has been reopened and will be reviewed again.',
  },
};

/**
 * Human-friendly dispute reference quoted in notifications, e.g. DSP-1A2B3C4D.
 * Derived from the document id, so it is stable and needs no extra storage.
 *
 * @param {object} dispute
 * @returns {string}
 */
function disputeReference(dispute) {
  const id = String(dispute?._id || '');
  return `DSP-${id.slice(-8).toUpperCase()}`;
}

function _isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function _loadSchool(schoolId) {
  try {
    return await School.findOne({ schoolId }).lean();
  } catch (err) {
    logger.warn('Failed to load school for dispute notification', { schoolId, error: err.message });
    return null;
  }
}

/**
 * Resolve where the raiser's notifications go: the contact captured on the
 * dispute, otherwise the student's parent contact.
 *
 * @param {object} dispute
 * @returns {Promise<{email: string|null, phone: string|null}>}
 */
async function resolveRaiserContact(dispute) {
  let email = _isEmail(dispute.raisedByEmail) ? dispute.raisedByEmail.trim() : null;
  let phone = isValidE164(dispute.raisedByPhone) ? dispute.raisedByPhone.trim() : null;

  if (!email && !phone) {
    try {
      // Not lean: the Student post('init') hook decrypts the parent contact.
      const student = await Student.findOne({ schoolId: dispute.schoolId, studentId: dispute.studentId })
        .select('parentEmail parentPhone parentEmailSuppressed');
      if (student) {
        if (_isEmail(student.parentEmail) && !student.parentEmailSuppressed) email = student.parentEmail;
        if (isValidE164(student.parentPhone)) phone = student.parentPhone;
      }
    } catch (err) {
      logger.warn('Failed to load student contact for dispute notification', {
        schoolId: dispute.schoolId, disputeId: String(dispute._id), error: err.message,
      });
    }
  }

  return { email, phone };
}

/**
 * Recipients for admin alerts: the school's contact/admin email plus its
 * active owner and staff users, de-duplicated.
 *
 * @param {string} schoolId
 * @param {object|null} [school]
 * @returns {Promise<string[]>}
 */
async function getAdminRecipients(schoolId, school = null) {
  const recipients = new Set();
  const schoolDoc = school || await _loadSchool(schoolId);
  for (const addr of [schoolDoc?.contactEmail, schoolDoc?.adminEmail]) {
    if (_isEmail(addr)) recipients.add(addr.trim().toLowerCase());
  }
  try {
    const users = await User.find({ schoolId, isActive: true, roles: { $in: ADMIN_ROLES } })
      .select('email')
      .lean();
    for (const u of users) {
      if (_isEmail(u.email)) recipients.add(u.email.trim().toLowerCase());
    }
  } catch (err) {
    logger.warn('Failed to load school users for dispute alert', { schoolId, error: err.message });
  }
  return [...recipients];
}

function _templateVars(dispute, school, extra) {
  return {
    reference: disputeReference(dispute),
    statusLabel: STATUS_LABELS[dispute.status] || dispute.status,
    txHash: dispute.txHash,
    studentId: dispute.studentId,
    schoolName: school?.name || 'StellarEduPay',
    logoUrl: school?.logoUrl || '',
    primaryColor: school?.primaryColor || '#1a56db',
    locale: school?.emailLocale || 'en',
    ...extra,
  };
}

/**
 * Notify the dispute raiser of a new dispute or a status change.
 *
 * @param {object} dispute  Dispute document (contact fields decrypted)
 * @param {'created'|'under_review'|'resolved'|'rejected'|'reopened'} kind
 * @returns {Promise<{email: object|null, sms: object|null}>}
 */
async function notifyRaiser(dispute, kind) {
  const copy = RAISER_COPY[kind];
  if (!copy) return { email: null, sms: null };

  const result = { email: null, sms: null };
  try {
    const [{ email, phone }, school] = await Promise.all([
      resolveRaiserContact(dispute),
      _loadSchool(dispute.schoolId),
    ]);
    const reference = disputeReference(dispute);

    if (email) {
      const { text, html } = renderEmailTemplate('disputeNotification', _templateVars(dispute, school, {
        greeting: 'Dear Parent/Guardian,',
        message: copy.message,
        reason: kind === 'created' ? dispute.reason : '',
        resolutionNote: kind === 'created' ? '' : (dispute.resolutionNote || ''),
        slaDeadline: kind === 'created' && dispute.slaDeadline ? new Date(dispute.slaDeadline).toISOString() : '',
        footer: school?.supportContact ? `Questions? Contact the school at ${school.supportContact}.` : '',
      }));
      result.email = await sendEmail({
        to: email,
        subject: copy.subject(reference),
        text,
        html,
        category: 'dispute',
      });
    }

    if (phone) {
      const statusLabel = STATUS_LABELS[dispute.status] || dispute.status;
      const body = kind === 'created'
        ? `${school?.name || 'StellarEduPay'}: we received your payment dispute. Reference ${reference}. We will keep you updated.`
        : `${school?.name || 'StellarEduPay'}: your payment dispute ${reference} is now ${statusLabel.toLowerCase()}.`;
      result.sms = await sendSms(phone, body);
    }

    if (!email && !phone) {
      logger.info('No contact for dispute raiser; notification skipped', {
        schoolId: dispute.schoolId, disputeId: String(dispute._id), kind,
      });
    }
  } catch (err) {
    logger.warn('Failed to notify dispute raiser', {
      schoolId: dispute.schoolId, disputeId: String(dispute._id), kind, error: err.message,
    });
  }
  return result;
}

/**
 * Alert school admins about a new dispute or an SLA breach.
 *
 * @param {object} dispute
 * @param {'created'|'sla_breached'} kind
 * @returns {Promise<number>} number of admin emails sent
 */
async function notifyAdmins(dispute, kind) {
  let sent = 0;
  try {
    const school = await _loadSchool(dispute.schoolId);
    const recipients = await getAdminRecipients(dispute.schoolId, school);
    if (recipients.length === 0) {
      logger.info('No admin recipients for dispute alert', { schoolId: dispute.schoolId, kind });
      return 0;
    }

    const reference = disputeReference(dispute);
    const breached = kind === 'sla_breached';
    const subject = breached
      ? `Dispute ${reference} has breached its resolution SLA`
      : `New payment dispute raised (${reference})`;
    const message = breached
      ? 'The dispute below is still unresolved past its SLA deadline and needs attention.'
      : 'A new payment dispute has been raised and is waiting for review on the Disputes page.';

    const { text, html } = renderEmailTemplate('disputeNotification', _templateVars(dispute, school, {
      greeting: 'Hello,',
      message,
      raisedBy: dispute.raisedBy,
      reason: dispute.reason,
      slaDeadline: dispute.slaDeadline ? new Date(dispute.slaDeadline).toISOString() : '',
      footer: '',
    }));

    for (const to of recipients) {
      const res = await sendEmail({ to, subject, text, html, category: 'dispute_admin' });
      if (res && res.sent) sent++;
    }
  } catch (err) {
    logger.warn('Failed to alert admins about dispute', {
      schoolId: dispute.schoolId, disputeId: String(dispute._id), kind, error: err.message,
    });
  }
  return sent;
}

// ── SLA sweep ────────────────────────────────────────────────────────────────

/**
 * Mark open disputes past their SLA as breached and alert admins once each.
 * Each dispute is claimed atomically (slaBreachNotifiedAt null → now), so a
 * dispute is never alerted twice even if two sweeps overlap.
 *
 * @param {Date} [now]
 * @returns {Promise<{breached: number}>}
 */
async function processSlaBreaches(now = new Date()) {
  const { dispatchToSchool } = require('./webhookService');
  const { emit: sseEmit } = require('./sseService');

  let breached = 0;
  for (let i = 0; i < SLA_SWEEP_BATCH; i++) {
    // Cross-tenant maintenance query — the sweep has no school context.
    const dispute = await Dispute.findOneAndUpdate(
      {
        status: { $in: ['open', 'under_review'] },
        slaDeadline: { $ne: null, $lt: now },
        slaBreachNotifiedAt: null,
      },
      // Pipeline update so an earlier slaBreachedAt / escalatedAt (set by the
      // model's pre-save hook) is kept rather than overwritten.
      [{
        $set: {
          slaBreachNotifiedAt: now,
          escalationLevel: 2,
          slaBreachedAt: { $ifNull: ['$slaBreachedAt', now] },
          escalatedAt: { $ifNull: ['$escalatedAt', now] },
        },
      }],
      { new: true, sort: { slaDeadline: 1 } }
    ).bypassTenantScope();
    if (!dispute) break;
    breached++;

    logger.warn('Dispute SLA breached', {
      schoolId: dispute.schoolId, disputeId: String(dispute._id), slaDeadline: dispute.slaDeadline,
    });

    await notifyAdmins(dispute, 'sla_breached');

    try {
      sseEmit(dispute.schoolId, 'dispute.sla_breached', {
        disputeId: dispute._id,
        txHash: dispute.txHash,
        studentId: dispute.studentId,
        status: dispute.status,
        slaDeadline: dispute.slaDeadline,
      });
    } catch (err) {
      logger.warn('SSE emit failed for dispute SLA breach', { error: err.message });
    }

    try {
      await dispatchToSchool(dispute.schoolId, 'dispute.sla_breached', {
        disputeId: String(dispute._id),
        schoolId: dispute.schoolId,
        txHash: dispute.txHash,
        studentId: dispute.studentId,
        status: dispute.status,
        slaDeadline: dispute.slaDeadline,
        slaBreachedAt: dispute.slaBreachedAt,
        createdAt: dispute.createdAt,
      });
    } catch (err) {
      logger.warn('Webhook fire failed for dispute SLA breach', { error: err.message });
    }
  }

  if (breached > 0) {
    try {
      const { refreshOpenDisputeGauge } = require('../metrics/disputeMetrics');
      await refreshOpenDisputeGauge();
    } catch (_) {}
  }

  return { breached };
}

let _timer = null;
let _running = false;

async function _runSweep() {
  if (_running) return;
  _running = true;
  try {
    await processSlaBreaches();
  } catch (err) {
    logger.error('Dispute SLA sweep failed', { error: err.message });
  } finally {
    _running = false;
  }
}

function startDisputeSlaScheduler() {
  if (_timer) return;
  _timer = setInterval(_runSweep, SLA_SWEEP_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

function stopDisputeSlaScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  disputeReference,
  resolveRaiserContact,
  getAdminRecipients,
  notifyRaiser,
  notifyAdmins,
  processSlaBreaches,
  startDisputeSlaScheduler,
  stopDisputeSlaScheduler,
};
