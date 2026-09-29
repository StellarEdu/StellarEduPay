'use strict';

const { getSchoolSettings } = require('./schoolSettingsService');

const DEFAULT_REMINDER_INTERVAL_MS = Number(process.env.REMINDER_INTERVAL_MS) || 60 * 60 * 1000;

/**
 * Determine whether a school is due for a reminder run.
 *
 * A single global setInterval drives the scheduler, so per-school intervals
 * cannot be implemented with separate timers. Instead we honour each school's
 * `reminderIntervalMs` setting by comparing it against the time elapsed since
 * the school was last reminded (`lastRemindedAt`).
 *
 * @param {object} school - school record, may include `lastRemindedAt`
 * @param {Date|number} now - current time
 * @returns {boolean} true when the school should be reminded now
 */
function isSchoolDueForReminder(school, now = new Date()) {
  if (!school) return false;

  let intervalMs = DEFAULT_REMINDER_INTERVAL_MS;
  try {
    const settings = getSchoolSettings(school.id);
    if (settings && Number.isFinite(settings.reminderIntervalMs) && settings.reminderIntervalMs > 0) {
      intervalMs = settings.reminderIntervalMs;
    }
  } catch (err) {
    // Fall back to the global interval when settings cannot be resolved.
  }

  if (!school.lastRemindedAt) return true;

  const last = new Date(school.lastRemindedAt).getTime();
  if (!Number.isFinite(last)) return true;

  return now.getTime() - last >= intervalMs;
}

module.exports = {
  DEFAULT_REMINDER_INTERVAL_MS,
  isSchoolDueForReminder,
};
