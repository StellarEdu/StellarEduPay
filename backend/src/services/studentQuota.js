'use strict';

const Student = require('../models/studentModel');
const lock = require('./distributedLock');

/**
 * Per-school student quota enforcement (#1801).
 *
 * Checking `countDocuments` and then inserting is not atomic: concurrent
 * registrations all read the same count and all insert. withStudentQuota()
 * serialises the check and the write for one school behind a distributed lock,
 * and counts the active students while the lock is held. The limit itself
 * comes from the resolved school; superAdminController.updateQuota invalidates
 * that cache on every replica, so a changed limit takes effect immediately.
 */

const LOCK_TTL_MS = 10000;
const BUSY = Symbol('student-quota-busy');

function studentQuotaError(maxStudents) {
  const err = new Error(`School has reached maximum student quota of ${maxStudents}`);
  err.code = 'STUDENT_QUOTA_EXCEEDED';
  err.status = 403;
  return err;
}

function studentQuotaBusyError() {
  const err = new Error('Student registration is busy for this school. Please retry.');
  err.code = 'STUDENT_QUOTA_BUSY';
  err.status = 409;
  return err;
}

/**
 * Run `fn({ remaining, maxStudents })` while holding the school's quota lock.
 *
 * `remaining` is the number of free seats (Infinity when there is no quota). `fn` is expected to write only as many students as `remaining`
 * allows; it runs inside the lock so no other writer can take a seat first.
 *
 * Throws STUDENT_QUOTA_BUSY when another writer holds the lock, rather than
 * waiting, so a burst of requests fails fast instead of queueing.
 */
async function withStudentQuota(schoolId, maxStudents, fn) {
  const outcome = await lock.withLock(
    `student-quota:${schoolId}`,
    LOCK_TTL_MS,
    async () => {
      const count = maxStudents ? await Student.countDocuments({ schoolId, deletedAt: null }) : 0;
      const remaining = maxStudents ? Math.max(0, maxStudents - count) : Infinity;
      return fn({ remaining, maxStudents });
    },
    { onContended: BUSY }
  );

  if (outcome === BUSY) throw studentQuotaBusyError();
  return outcome.result;
}

module.exports = { withStudentQuota, studentQuotaError, studentQuotaBusyError };
