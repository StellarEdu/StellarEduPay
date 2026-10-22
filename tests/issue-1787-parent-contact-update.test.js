'use strict';

/**
 * Regression test for issue #1787: PATCH /students/:id silently ignored
 * parentEmail and parentPhone, so a mistyped contact could never be fixed.
 *
 * No database is needed: the lookup returns a real Student document and the
 * model's pre('save') hook (encryption + blind-index hash, studentModel.js)
 * is executed against it, so the assertions check what would be stored.
 */

process.env.STUDENT_PII_ENCRYPTION_KEY = 'a'.repeat(64);

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const { logAudit } = require('../backend/src/services/auditService');
const Student = require('../backend/src/models/studentModel');
const { updateStudent } = require('../backend/src/controllers/studentController');
const { hashParentEmail, decryptStudentPii } = require('../backend/src/services/studentPiiEncryption');

const SCHOOL_ID = 'school-1787';
const STUDENT_ID = 'STU-1787';

function seedFields() {
  return {
    schoolId: SCHOOL_ID,
    studentId: STUDENT_ID,
    name: 'Ada Lovelace',
    class: 'Grade 5',
    feeAmount: 100,
    parentEmail: 'mistyped@exmaple.com',
    parentPhone: '+14155550100',
    reminderCount: 3,
    parentEmailSuppressed: true,
    parentEmailSuppressionReason: 'bounced',
  };
}

// Runs the model's own pre('save') hook, so the value is encrypted before it is
// written. The post('save') hook only decrypts the in-memory copy for the caller;
// it is mirrored here because kareem's execPost does not run it outside mongoose.
function runPreSaveHook(doc) {
  return new Promise((resolve, reject) =>
    Student.schema.s.hooks.execPre('save', doc, [], (err) => (err ? reject(err) : resolve()))
  );
}

function decryptForCaller(doc) {
  if (doc.parentEmail != null) doc.parentEmail = decryptStudentPii(doc.parentEmail);
  if (doc.parentPhone != null) doc.parentPhone = decryptStudentPii(doc.parentPhone);
}

function persistedDocFrom(fields) {
  const doc = new Student(fields);
  doc.save = jest.fn(async function save() {
    await runPreSaveHook(doc);
    const stored = { parentEmail: doc.parentEmail, parentPhone: doc.parentPhone };
    doc.storedContact = stored;
    decryptForCaller(doc);
    return doc;
  });
  return doc;
}

function stubLookup(fields) {
  const doc = persistedDocFrom(fields);
  jest.spyOn(Student, 'findOne')
    .mockReturnValueOnce({ lean: () => Promise.resolve({ ...fields }) }) // original snapshot for 404 + audit
    .mockResolvedValueOnce(doc);                                          // document that gets saved
  return doc;
}

function call(body) {
  const req = {
    schoolId: SCHOOL_ID,
    params: { studentId: STUDENT_ID },
    body,
    auditContext: { performedBy: 'admin-1', ipAddress: '127.0.0.1', userAgent: 'jest' },
  };
  const res = { json: jest.fn() };
  const next = jest.fn();
  return updateStudent(req, res, next).then(() => ({ res, next }));
}

describe('updateStudent parent contact fields (#1787)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('applies a corrected parentEmail and parentPhone and returns them', async () => {
    stubLookup(seedFields());
    const { res, next } = await call({ parentEmail: 'Parent@Example.com', parentPhone: '+14155550199' });

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.parentEmail).toBe('parent@example.com');
    expect(body.parentPhone).toBe('+14155550199');
  });

  it('stores the contact fields encrypted and refreshes the blind-index hash', async () => {
    const doc = stubLookup(seedFields());
    await call({ parentEmail: 'parent@example.com', parentPhone: '+14155550199' });

    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(doc.storedContact.parentEmail.startsWith('enc:')).toBe(true);
    expect(doc.storedContact.parentPhone.startsWith('enc:')).toBe(true);
    expect(doc.storedContact.parentEmail).not.toContain('parent@example.com');
    expect(decryptStudentPii(doc.storedContact.parentEmail)).toBe('parent@example.com');
    expect(doc.parentEmailHash).toBe(hashParentEmail('parent@example.com'));
  });

  it('clears suppression and resets reminder counters when the email changes', async () => {
    const doc = stubLookup(seedFields());
    await call({ parentEmail: 'parent@example.com' });

    expect(doc.parentEmailSuppressed).toBe(false);
    expect(doc.parentEmailSuppressionReason).toBeNull();
    expect(doc.reminderCount).toBe(0);
  });

  it('audits the contact change with masked values only', async () => {
    stubLookup(seedFields());
    await call({ parentEmail: 'parent@example.com', parentPhone: '+14155550199' });

    expect(logAudit).toHaveBeenCalledTimes(1);
    const { details } = logAudit.mock.calls[0][0];
    expect(details.before.parentEmail).toBe('m***@exmaple.com');
    expect(details.before.parentPhone).toBe('****0100');
    expect(details.after.parentEmail).toBe('p***@example.com');
    expect(details.after.parentPhone).toBe('****0199');
    expect(JSON.stringify(details)).not.toMatch(/mistyped|parent@example|5550199/);
  });

  it('rejects a malformed parentEmail with a 400 and saves nothing', async () => {
    const doc = stubLookup(seedFields());
    const { res, next } = await call({ parentEmail: 'not-an-email' });

    expect(res.json).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('leaves contact fields and reminder state alone when they are not in the request', async () => {
    const doc = stubLookup(seedFields());
    await call({ name: 'Ada L.' });

    expect(doc.reminderCount).toBe(3);
    expect(doc.parentEmailSuppressed).toBe(true);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0].details.before.parentEmail).toBeUndefined();
  });
});
