'use strict';

/**
 * Student quota enforcement (#1801).
 *
 * Verifies:
 *   1. Concurrent registrations at quota − 1 never push the school past maxStudents.
 *   2. The active count is read while the lock is held, so the check sees the latest writes.
 *   3. A contended quota lock fails fast with STUDENT_QUOTA_BUSY instead of queueing.
 *   4. updateQuota drops the cached school so every replica sees the new limit.
 */

const School = require('../src/models/schoolModel');
const Student = require('../src/models/studentModel');
const schoolCache = require('../src/services/schoolCacheInvalidator');
const { withStudentQuota, studentQuotaError } = require('../src/services/studentQuota');
const superAdminController = require('../src/controllers/superAdminController');

const SCHOOL_ID = 'SCH-QUOTA-1801';

// In-memory stand-in for the students collection so the concurrency test
// exercises the real lock without a database.
function fakeStudentStore(initial) {
  const docs = [...initial];
  jest.spyOn(Student, 'countDocuments').mockImplementation(async () => {
    await new Promise(resolve => setImmediate(resolve));
    return docs.length;
  });
  jest.spyOn(Student, 'create').mockImplementation(async doc => {
    docs.push(doc);
    return doc;
  });
  return docs;
}

// Mirrors studentController.createStudentWithinQuota; maxStudents comes from req.school.
function registerOne(index, maxStudents) {
  return withStudentQuota(SCHOOL_ID, maxStudents, ({ remaining, maxStudents: limit }) => {
    if (remaining < 1) throw studentQuotaError(limit);
    return Student.create({ schoolId: SCHOOL_ID, studentId: `S-${index}` });
  });
}

describe('Student quota enforcement (#1801)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('never exceeds maxStudents under concurrent registrations', async () => {
    const docs = fakeStudentStore(Array.from({ length: 9 }, (_, i) => ({ studentId: `old-${i}` })));

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => registerOne(i, 10))
    );

    const created = outcomes.filter(o => o.status === 'fulfilled').length;
    expect(created).toBeGreaterThanOrEqual(1);
    expect(docs.length).toBeLessThanOrEqual(10);
    expect(docs.length).toBe(9 + created);
  });

  it('rejects a write once the active count reaches the limit', async () => {
    fakeStudentStore([{ studentId: 'a' }, { studentId: 'b' }, { studentId: 'c' }]);

    await expect(registerOne(1, 3)).rejects.toMatchObject({
      code: 'STUDENT_QUOTA_EXCEEDED',
      message: 'School has reached maximum student quota of 3',
    });
  });

  it('allows writes when the school has no quota', async () => {
    const docs = fakeStudentStore(Array.from({ length: 500 }, (_, i) => ({ studentId: `s-${i}` })));

    await registerOne(1, undefined);

    expect(docs.length).toBe(501);
  });

  it('fails fast with STUDENT_QUOTA_BUSY when another writer holds the lock', async () => {
    fakeStudentStore([]);

    let markHeld;
    const held = new Promise(resolve => { markHeld = resolve; });
    let releaseFirst;
    const first = withStudentQuota(SCHOOL_ID, 10, () => {
      markHeld();
      return new Promise(resolve => { releaseFirst = resolve; });
    });
    await held;

    await expect(withStudentQuota(SCHOOL_ID, 10, () => 'second')).rejects.toMatchObject({
      code: 'STUDENT_QUOTA_BUSY',
      status: 409,
    });

    releaseFirst('first');
    await expect(first).resolves.toBe('first');
  });

  it('invalidates the cached school when the quota is updated', async () => {
    const updated = { schoolId: SCHOOL_ID, slug: 'quota-school', maxStudents: 25 };
    jest.spyOn(School, 'findOneAndUpdate').mockResolvedValue(updated);
    const invalidate = jest.spyOn(schoolCache, 'invalidate').mockImplementation(() => {});

    const req = { params: { schoolId: SCHOOL_ID }, body: { maxStudents: 25 }, auditContext: null };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await superAdminController.updateQuota(req, res, jest.fn());

    expect(invalidate).toHaveBeenCalledWith(updated);
    expect(res.json).toHaveBeenCalledWith(updated);
  });
});
