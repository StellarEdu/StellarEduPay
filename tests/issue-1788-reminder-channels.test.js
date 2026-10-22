'use strict';

/**
 * Regression test for issue #1788: reminders were gated on SMTP_* being set and
 * selected only students with a parent email, so SendGrid/SES-only schools and
 * SMS-only parents never received anything.
 *
 * Models, notification senders and the email provider are mocked so the test
 * checks the channel decisions made by processReminders.
 */

jest.mock('../backend/src/config', () => ({
  REMINDER_INTERVAL_MS: 60000,
  REMINDER_COOLDOWN_HOURS: 24,
  REMINDER_MAX_COUNT: 5,
}));

const mockStudentFind = jest.fn();
const mockStudentUpdate = jest.fn().mockResolvedValue({});
jest.mock('../backend/src/models/studentModel', () => ({
  find: (...args) => mockStudentFind(...args),
  findByIdAndUpdate: (...args) => mockStudentUpdate(...args),
}));

const mockSchoolFind = jest.fn();
jest.mock('../backend/src/models/schoolModel', () => ({
  find: (...args) => mockSchoolFind(...args),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/reminderLogModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/services/notificationService', () => ({
  sendFeeReminder: jest.fn().mockResolvedValue({ sent: true }),
  sendSmsReminder: jest.fn().mockResolvedValue({ sent: true }),
  sendWhatsAppReminder: jest.fn().mockResolvedValue({ sent: true }),
  verifySmtp: jest.fn().mockResolvedValue({ ok: true }),
}));

let mockTwilio = false;
jest.mock('../backend/src/services/smsService', () => ({
  isTwilioConfigured: () => mockTwilio,
}));

let mockProvider = 'sendgrid';
jest.mock('../backend/src/services/email/emailProvider', () => ({
  resolveProviderName: () => mockProvider,
}));

jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const notifications = require('../backend/src/services/notificationService');
const reminderService = require('../backend/src/services/reminderService');

const SCHOOL = {
  schoolId: 'school-1788',
  name: 'Test School',
  timezone: 'UTC',
  // Whole-day window so the test does not depend on the wall-clock hour.
  settings: { reminderTimeWindow: { startHour: 0, endHour: 24 } },
};

function student(overrides) {
  return {
    _id: 'mongo-id',
    studentId: 'STU-1788',
    name: 'Ada',
    class: 'Grade 5',
    feeAmount: 100,
    feePaid: false,
    reminderCount: 0,
    parentEmail: null,
    parentPhone: null,
    parentEmailSuppressed: false,
    ...overrides,
  };
}

function primeStudents(list) {
  mockSchoolFind.mockReturnValue({ lean: () => Promise.resolve([SCHOOL]) });
  mockStudentFind.mockResolvedValue(list);
}

describe('reminder channels (#1788)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilio = false;
    mockProvider = 'sendgrid';
  });

  it('runs reminders with a SendGrid-only school and queries parents by email', async () => {
    primeStudents([student({ parentEmail: 'parent@example.com' })]);

    const summary = await reminderService.processReminders();

    expect(summary.channelsNotConfigured).toBeUndefined();
    const query = mockStudentFind.mock.calls[0][0];
    expect(query.$or).toEqual([{ parentEmail: { $ne: null, $exists: true } }]);
    expect(notifications.sendFeeReminder).toHaveBeenCalledWith(expect.objectContaining({ to: 'parent@example.com' }));
  });

  it('runs reminders with an SES-only school', async () => {
    mockProvider = 'ses';
    primeStudents([student({ parentEmail: 'parent@example.com' })]);

    const summary = await reminderService.processReminders();

    expect(summary.channelsNotConfigured).toBeUndefined();
    expect(notifications.sendFeeReminder).toHaveBeenCalledTimes(1);
  });

  it('reaches SMS-only parents when Twilio is configured and no email provider is', async () => {
    mockProvider = 'console';
    mockTwilio = true;
    primeStudents([student({ parentPhone: '+14155550199' })]);

    await reminderService.processReminders();

    const query = mockStudentFind.mock.calls[0][0];
    expect(query.$or).toEqual([{ parentPhone: { $ne: null, $exists: true } }]);
    expect(notifications.sendSmsReminder).toHaveBeenCalledWith(expect.objectContaining({ to: '+14155550199' }));
    expect(notifications.sendFeeReminder).not.toHaveBeenCalled();
    expect(notifications.verifySmtp).not.toHaveBeenCalled();
  });

  it('selects both kinds of contact when email and SMS are configured', async () => {
    mockTwilio = true;
    primeStudents([student({ parentEmail: 'parent@example.com', parentPhone: '+14155550199' })]);

    await reminderService.processReminders();

    const query = mockStudentFind.mock.calls[0][0];
    expect(query.$or).toEqual([
      { parentEmail: { $ne: null, $exists: true } },
      { parentPhone: { $ne: null, $exists: true } },
    ]);
  });

  it('falls back to SMS for a phone-only parent when the school prefers email', async () => {
    mockTwilio = true;
    primeStudents([student({ parentPhone: '+14155550199' })]);

    await reminderService.processReminders();

    expect(notifications.sendSmsReminder).toHaveBeenCalledTimes(1);
    expect(notifications.sendFeeReminder).not.toHaveBeenCalled();
  });

  it('skips the run and reports why when no channel is configured', async () => {
    mockProvider = 'console';
    mockTwilio = false;

    const summary = await reminderService.processReminders();

    expect(summary.channelsNotConfigured).toBe(true);
    expect(mockStudentFind).not.toHaveBeenCalled();
    expect(reminderService.getReminderStatus()).toMatchObject({ enabled: false, reason: expect.any(String) });
  });

  it('reports enabled once a channel is configured', async () => {
    primeStudents([]);
    await reminderService.processReminders();

    expect(reminderService.getReminderStatus()).toMatchObject({ enabled: true, reason: null });
  });
});
