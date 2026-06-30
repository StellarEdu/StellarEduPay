'use strict';

/**
 * Reminder Service — Unpaid Fee Notifications
 *
 * Runs on a configurable interval and sends email reminders to parents
 * of students whose fees are unpaid. Respects a per-student cooldown
 * and a maximum reminder count to prevent inbox flooding.
 *
 * Config (all via environment variables):
 *   REMINDER_INTERVAL_MS     — how often the scheduler runs (default: 24h)
 *   REMINDER_COOLDOWN_HOURS  — min hours between reminders per student (default: 48h)
 *   REMINDER_MAX_COUNT       — stop reminding after N reminders (default: 5)
 */

const Student = require('../models/studentModel');
const School  = require('../models/schoolModel');
const Payment = require('../models/paymentModel');
const ReminderLog = require('../models/reminderLogModel');
const { sendFeeReminder, verifySmtp } = require('./notificationService');
const config = require('../config');
const logger = require('../utils/logger').child('ReminderService');

const {
  REMINDER_INTERVAL_MS,
  REMINDER_COOLDOWN_HOURS,
  REMINDER_MAX_COUNT,
} = config;

let _timer  = null;
let _running = false;
let _lastRunAt = null;
let _lastRunSummary = null;

// Circuit breaker state
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_HALF_OPEN_AFTER_MS = 10 * 60 * 1000; // 10 minutes
let _circuitState = 'closed'; // 'closed' | 'open' | 'half-open'
let _consecutiveFailures = 0;
let _circuitOpenedAt = null;

/**
 * Check if SMTP is properly configured
 */
function isSmtpConfigured() {
  return !!(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

/**
 * Return true if the current wall-clock time in the given IANA timezone falls
 * within the school's configured send window.
 *
 * The window is read from school.settings.reminderTimeWindow:
 *   { startHour: 8, endHour: 18 }  (default, meaning 08:00–17:59 local time)
 *
 * When the setting is absent or malformed the default 08:00–17:59 window is used.
 */
function isInSendWindow(school) {
  const timezone = school.timezone || 'UTC';
  const now = new Date();
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(now),
    10
  );

  const defaults = { startHour: 8, endHour: 18 };
  const win = (school.settings && school.settings.reminderTimeWindow) || {};
  const startHour = (win.startHour != null ? win.startHour : defaults.startHour);
  const endHour   = (win.endHour   != null ? win.endHour   : defaults.endHour);

  return hour >= startHour && hour < endHour;
}

/**
 * Determine whether a student is eligible for a reminder right now.
 */
function isEligible(student) {
  if (student.feePaid)          return false;
  if (!student.parentEmail)     return false;
  if (student.reminderOptOut)   return false;
  if (student.reminderCount >= REMINDER_MAX_COUNT) return false;

  if (student.lastReminderSentAt) {
    const cooldownMs = REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000;
    const elapsed    = Date.now() - new Date(student.lastReminderSentAt).getTime();
    if (elapsed < cooldownMs) return false;
  }

  return true;
}

/**
 * Compute the start of the current calendar day (00:00:00.000) in the school's
 * timezone.  This is used as the idempotency window — at most one reminder per
 * student per calendar day regardless of how many replicas fire or restarts occur.
 */
function computeWindowStart(timezone) {
  const opts = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date());
  const isoDate = parts.map(p => p.value).join('').slice(0, 10); // YYYY-MM-DD
  return new Date(isoDate + 'T00:00:00.000Z');
}

/**
 * Process all active schools and send reminders for eligible students.
 * Returns a summary object for logging / API response.
 */
async function processReminders() {
  // Skip if SMTP is not configured
  if (!isSmtpConfigured()) {
    logger.warn('SMTP not configured — skipping reminder run');
    return { schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0, smtpNotConfigured: true };
  }

  // Verify SMTP connectivity before processing any students
  const smtpCheck = await verifySmtp();
  if (!smtpCheck.ok) {
    logger.error('SMTP verification failed — aborting reminder run to prevent quota consumption', { error: smtpCheck.error });
    return { schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0, smtpVerifyFailed: true, smtpError: smtpCheck.error };
  }

  const summary = { schools: 0, eligible: 0, sent: 0, failed: 0, skipped: 0 };

  const schools = await School.find({ isActive: true }).lean();
  summary.schools = schools.length;

  for (const school of schools) {
    // Per-school reminder kill switch
    if (school.settings && school.settings.reminderEnabled === false) {
      logger.debug('Reminders disabled for school', { schoolId: school.schoolId });
      summary.skipped++;
      continue;
    }

    if (!isInSendWindow(school)) {
      logger.info('Outside send window — skipping school', {
        schoolId: school.schoolId,
        timezone: school.timezone || 'UTC',
        window:   (school.settings && school.settings.reminderTimeWindow) || { startHour: 8, endHour: 18 },
      });
      summary.skipped++;
      continue;
    }

    // Fetch all unpaid students in this school that have a parent email
    const unpaidStudents = await Student.find({
      schoolId:    school.schoolId,
      feePaid:     false,
      parentEmail: { $ne: null, $exists: true },
      reminderOptOut: { $ne: true },
    });

    for (const student of unpaidStudents) {
      if (!isEligible(student)) {
        summary.skipped++;
        continue;
      }

      // Circuit breaker: check state before each send
      if (_circuitState === 'open') {
        if (Date.now() - _circuitOpenedAt >= CIRCUIT_HALF_OPEN_AFTER_MS) {
          _circuitState = 'half-open';
          logger.warn('Circuit half-open — testing email provider', { schoolId: school.schoolId });
        } else {
          summary.skipped++;
          continue;
        }
      }

      summary.eligible++;

      try {
        // Fresh balance check — skip if student has actually paid in full
        const paymentAgg = await Payment.aggregate([
          { $match: { schoolId: school.schoolId, studentId: student.studentId, deletedAt: null } },
          { $group: { _id: null, totalPaid: { $sum: '$amount' } } },
        ]);
        const totalPaid = paymentAgg.length ? paymentAgg[0].totalPaid : 0;
        const remainingBalance = Math.max(0, (student.feeAmount || 0) - totalPaid);

        if (remainingBalance <= 0) {
          summary.skipped++;
          logger.debug('Skipping reminder — already paid', { studentId: student.studentId, schoolId: school.schoolId });
          continue;
        }

        // Idempotency: claim this (school, student, day) slot atomically.
        // If another replica or a mid-batch restart already sent for today, skip.
        const windowStart = computeWindowStart(school.timezone || 'UTC');
        try {
          await ReminderLog.create({
            schoolId: school.schoolId,
            studentId: student.studentId,
            windowStart,
          });
        } catch (err) {
          if (err.code === 11000) { // duplicate key
            logger.debug('Reminder already sent for today — skipping', {
              studentId: student.studentId,
              schoolId: school.schoolId,
              windowStart,
            });
            summary.skipped++;
            continue;
          }
          throw err;
        }

        const result = await sendFeeReminder({
          to:               student.parentEmail,
          studentName:      student.name,
          studentId:        student.studentId,
          schoolId:         school.schoolId,
          className:        student.class,
          feeAmount:        student.feeAmount,
          remainingBalance,
          schoolName:       school.name,
          reminderCount:    (student.reminderCount || 0) + 1,
        });

        // Only update tracking fields if email was actually sent
        if (result.sent) {
          await Promise.all([
            Student.findByIdAndUpdate(student._id, {
              $set: { lastReminderSentAt: new Date() },
              $inc: { reminderCount: 1 },
            }),
            ReminderLog.updateOne(
              { schoolId: school.schoolId, studentId: student.studentId, windowStart },
              { $set: { status: 'sent', sentAt: new Date() } }
            ),
          ]);
          summary.sent++;
          // Successful send — reset circuit
          if (_circuitState !== 'closed') {
            _circuitState = 'closed';
            logger.warn('Circuit closed — email provider recovered');
          }
          _consecutiveFailures = 0;
        } else {
          // Email wasn't sent (dev mode / no SMTP) — keep the idempotency
          // record so the same student isn't skipped on the next tick.
          await ReminderLog.updateOne(
            { schoolId: school.schoolId, studentId: student.studentId, windowStart },
            { $set: { status: 'skipped' } }
          );
          summary.skipped++;
        }
      } catch (err) {
        summary.failed++;
        _consecutiveFailures++;
        logger.error('Failed to send reminder', {
          studentId: student.studentId,
          schoolId:  school.schoolId,
          error:     err.message,
        });

        if (_consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && _circuitState === 'closed') {
          _circuitState = 'open';
          _circuitOpenedAt = Date.now();
          logger.warn('Circuit opened — too many consecutive email failures', { consecutiveFailures: _consecutiveFailures });
          break;
        }
        if (_circuitState === 'half-open') {
          _circuitState = 'open';
          _circuitOpenedAt = Date.now();
          logger.warn('Circuit re-opened — email provider still failing');
          break;
        }
      }
    }
  }

  return summary;
}

/**
 * Single scheduler tick — wraps processReminders with error isolation.
 */
async function runReminders() {
  if (_running) {
    logger.warn('Previous reminder run still in progress — skipping tick');
    return;
  }
  _running = true;

  try {
    const summary = await processReminders();
    _lastRunAt = new Date().toISOString();
    _lastRunSummary = { sent: summary.sent, failed: summary.failed, skipped: summary.skipped };
    logger.info('Reminder run complete', summary);
  } catch (err) {
    _lastRunAt = new Date().toISOString();
    _lastRunSummary = { sent: 0, failed: 0, skipped: 0, error: err.message };
    logger.error('Reminder run failed', { error: err.message });
  } finally {
    _running = false;
  }
}

function startReminderScheduler() {
  if (_timer) return;
  
  if (!isSmtpConfigured()) {
    logger.warn('SMTP not configured — reminder scheduler will not start. Set SMTP_HOST, SMTP_USER, SMTP_PASS to enable.');
    return;
  }
  
  logger.info(`Starting — interval: ${REMINDER_INTERVAL_MS}ms, cooldown: ${REMINDER_COOLDOWN_HOURS}h, maxCount: ${REMINDER_MAX_COUNT}`);

  // Run once immediately so we don't wait a full interval on startup.
  // Each school's send window gate prevents blasting outside local hours.
  setImmediate(() => runReminders().catch(err => logger.error('Initial reminder run failed', { error: err.message })));

  _timer = setInterval(runReminders, REMINDER_INTERVAL_MS);
  _timer.unref(); // don't block process exit
}

function stopReminderScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('Stopped');
  }
}

function getReminderStatus() {
  return {
    schedulerRunning: _timer !== null,
    lastRunAt: _lastRunAt,
    lastRunSummary: _lastRunSummary,
    circuitState: _circuitState,
    consecutiveFailures: _consecutiveFailures,
  };
}

module.exports = { startReminderScheduler, stopReminderScheduler, processReminders, getReminderStatus };
