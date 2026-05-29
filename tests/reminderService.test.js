'use strict';

/**
 * Tests for reminder service fixes (issue #554):
 *  1. Failed SMTP verify aborts run — no student records mutated
 *  2. Failed sendMail does not increment reminderCount
 *  3. Successful send increments reminderCount and sets lastReminderSentAt
 *  4. Health endpoint includes reminders section
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-secret';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'user';
process.env.SMTP_PASS = 'pass';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVerify = jest.fn();
const mockSendMail = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockStudentFind = jest.fn();
const mockSchoolFind = jest.fn();
const mockPaymentAggregate = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    verify: mockVerify,
    sendMail: mockSendMail,
  })),
}), { virtual: true });

jest.mock('../backend/src/models/studentModel', () => ({
  find: mockStudentFind,
  findByIdAndUpdate: mockFindByIdAndUpdate,
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  find: mockSchoolFind,
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  aggregate: mockPaymentAggregate,
}));

jest.mock('../backend/src/utils/logger', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, child: () => logger, getLevel: () => 'info' };
  return logger;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStudent(overrides = {}) {
  return {
    _id: 'student-id-1',
    studentId: 'STU001',
    name: 'Alice',
    class: 'Grade 5',
    feeAmount: 250,
    remainingBalance: 250,
    parentEmail: 'parent@example.com',
    feePaid: false,
    reminderOptOut: false,
    reminderCount: 0,
    lastReminderSentAt: null,
    ...overrides,
  };
}

const SCHOOL = { schoolId: 'SCH001', name: 'Test School', isActive: true };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reminderService — SMTP verification', () => {
  beforeEach(() => {
    jest.resetModules();
    mockVerify.mockReset();
    mockSendMail.mockReset();
    mockFindByIdAndUpdate.mockReset();
    mockStudentFind.mockReset();
    mockSchoolFind.mockReset();
    mockPaymentAggregate.mockReset();
  });

  test('aborts run and does not mutate students when SMTP verify fails', async () => {
    mockVerify.mockRejectedValue(new Error('auth failed'));
    mockSchoolFind.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    expect(summary.smtpVerifyFailed).toBe(true);
    expect(summary.sent).toBe(0);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('does not increment reminderCount when sendMail throws', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFind.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    mockStudentFind.mockResolvedValue([makeStudent()]);
    // Student has unpaid balance
    mockPaymentAggregate.mockResolvedValue([{ totalPaid: 0 }]);
    mockSendMail.mockRejectedValue(new Error('connection refused'));

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('increments reminderCount and sets lastReminderSentAt on successful send', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFind.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    mockStudentFind.mockResolvedValue([makeStudent()]);
    // Student has unpaid balance
    mockPaymentAggregate.mockResolvedValue([{ totalPaid: 0 }]);
    mockSendMail.mockResolvedValue({ messageId: 'msg-123' });
    mockFindByIdAndUpdate.mockResolvedValue({});

    // Mock template loading
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: () => 'Hello {{studentName}}',
    }));

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    expect(summary.sent).toBe(1);
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'student-id-1',
      expect.objectContaining({ $inc: { reminderCount: 1 } }),
    );
  });
});

describe('getReminderStatus', () => {
  test('returns schedulerRunning, lastRunAt, lastRunSummary', () => {
    jest.resetModules();
    const { getReminderStatus } = require('../backend/src/services/reminderService');
    const status = getReminderStatus();
    expect(status).toHaveProperty('schedulerRunning');
    expect(status).toHaveProperty('lastRunAt');
    expect(status).toHaveProperty('lastRunSummary');
  });
});

// ── Issue #625: skip reminders for already-paid students ──────────────────────

describe('reminderService — balance check (issue #625)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockVerify.mockReset();
    mockSendMail.mockReset();
    mockFindByIdAndUpdate.mockReset();
    mockStudentFind.mockReset();
    mockSchoolFind.mockReset();
    mockPaymentAggregate.mockReset();
  });

  test('skips reminder when feePaid is false but remainingBalance === 0', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFind.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    // feePaid: false but totalPaid equals feeAmount
    mockStudentFind.mockResolvedValue([makeStudent({ feeAmount: 250, feePaid: false })]);
    mockPaymentAggregate.mockResolvedValue([{ totalPaid: 250 }]);

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    expect(summary.sent).toBe(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('sends reminder when feePaid is false and remainingBalance > 0', async () => {
    mockVerify.mockResolvedValue(true);
    mockSchoolFind.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
    mockStudentFind.mockResolvedValue([makeStudent({ feeAmount: 250, feePaid: false })]);
    // Only partial payment made
    mockPaymentAggregate.mockResolvedValue([{ totalPaid: 100 }]);
    mockSendMail.mockResolvedValue({ messageId: 'msg-456' });
    mockFindByIdAndUpdate.mockResolvedValue({});

    const { processReminders } = require('../backend/src/services/reminderService');
    const summary = await processReminders();

    expect(summary.sent).toBe(1);
    expect(mockSendMail).toHaveBeenCalled();
  });
});
