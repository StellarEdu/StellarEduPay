'use strict';

/**
 * Tests for the disputeHold feature — reminder suppression.
 *
 * These tests use jest.resetModules() to isolate the reminderService module
 * and must live in their own file so they don't corrupt other test suites.
 *
 * Covers:
 *   - disputeHold=true suppresses reminders
 *   - disputeHold=false (or absent) does not suppress reminders
 */

process.env.MONGO_URI    = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET   = 'test-secret';
process.env.SMTP_HOST    = 'smtp.example.com';
process.env.SMTP_USER    = 'user';
process.env.SMTP_PASS    = 'pass';

// ─── Persistent mock functions ───────────────────────────────────────────────
// These are declared outside beforeEach so they survive jest.resetModules()
// while still being reset between tests.

const mockVerify        = jest.fn();
const mockSendMail      = jest.fn();
const mockStudentFn     = jest.fn();
const mockSchoolFn      = jest.fn();
const mockAggFn         = jest.fn();
const mockFindByIdUpdate = jest.fn();

function makeStudent(overrides = {}) {
  return {
    _id:               'student-id-1',
    studentId:         'STU001',
    name:              'Alice',
    class:             'Grade 5',
    feeAmount:         250,
    remainingBalance:  250,
    parentEmail:       'parent@example.com',
    feePaid:           false,
    reminderOptOut:    false,
    reminderCount:     0,
    disputeHold:       false,
    lastReminderSentAt: null,
    ...overrides,
  };
}

const SCHOOL = { schoolId: 'SCH001', name: 'Test School', isActive: true, timezone: 'UTC' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reminderService.isEligible — disputeHold suppresses reminders', () => {
  beforeEach(() => {
    jest.resetModules();

    // Re-establish env vars after each reset
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';

    jest.mock('nodemailer', () => ({
      createTransport: jest.fn(() => ({
        verify:   mockVerify,
        sendMail: mockSendMail,
      })),
    }), { virtual: true });

    jest.mock('../backend/src/models/studentModel', () => ({
      find:              mockStudentFn,
      findByIdAndUpdate: mockFindByIdUpdate,
    }));
    jest.mock('../backend/src/models/schoolModel',  () => ({ find: mockSchoolFn }));
    jest.mock('../backend/src/models/paymentModel', () => ({ aggregate: mockAggFn }));

    // ReminderLog is a real mongoose model — without a DB its create()/updateOne()
    // never resolve and the eligible path hangs to a timeout. Mock the idempotency store.
    jest.mock('../backend/src/models/reminderLogModel', () => ({
      create:    jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
    }));

    // Email now flows through the pluggable email service, whose suppression
    // check hits a real mongoose model (EmailSuppression.findOne) — without a DB
    // it never resolves and the send path hangs. Neutralise the suppression check
    // so delivery proceeds to the (mocked) nodemailer smtp provider.
    jest.mock('../backend/src/services/email/suppressionList', () => ({
      isSuppressed: jest.fn().mockResolvedValue(false),
    }));

    // Mock logger to suppress noise
    jest.mock('../backend/src/utils/logger', () => {
      const noop = () => {};
      const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l, getLevel: () => 'info' };
      return l;
    });

    // Mock fs so template loading doesn't fail
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockReturnValue('Hello {{studentName}} owed {{outstanding}}'),
    }));

    // Mock unsubscribeToken used inside notificationService
    jest.mock('../backend/src/utils/unsubscribeToken', () => ({
      generateUnsubscribeToken: jest.fn().mockReturnValue('mock-token'),
    }));

    mockVerify.mockReset();
    mockSendMail.mockReset();
    mockStudentFn.mockReset();
    mockSchoolFn.mockReset();
    mockAggFn.mockReset();
    mockFindByIdUpdate.mockReset();
  });

  test('skips student with disputeHold=true — sent is 0, skipped ≥ 1, no email', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFn.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    mockStudentFn.mockResolvedValue([makeStudent({ disputeHold: true })]);
    mockAggFn.mockResolvedValue([{ totalPaid: 0 }]);

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    expect(summary.sent).toBe(0);
    // The student is ineligible due to disputeHold — counted as skipped
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends reminder when disputeHold=false — student is eligible (hold does not block)', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFn.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    mockStudentFn.mockResolvedValue([makeStudent({ disputeHold: false })]);
    mockAggFn.mockResolvedValue([{ totalPaid: 0 }]);
    // sendMail might or might not succeed based on env; what matters is the
    // student is eligible (eligible count ≥ 1), meaning disputeHold did NOT skip it.
    mockSendMail.mockResolvedValue({ messageId: 'msg-no-hold' });
    mockFindByIdUpdate.mockResolvedValue({});

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    // The student must be considered eligible — disputeHold=false does not suppress
    expect(summary.eligible).toBeGreaterThanOrEqual(1);
  });

  test('sends reminder when disputeHold is absent (old document, no field) — student is eligible', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFn.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    const student = makeStudent();
    delete student.disputeHold; // simulate old document without the field
    mockStudentFn.mockResolvedValue([student]);
    mockAggFn.mockResolvedValue([{ totalPaid: 0 }]);
    mockSendMail.mockResolvedValue({ messageId: 'msg-old-doc' });
    mockFindByIdUpdate.mockResolvedValue({});

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    // Old documents without disputeHold must not be blocked
    expect(summary.eligible).toBeGreaterThanOrEqual(1);
  });
});
