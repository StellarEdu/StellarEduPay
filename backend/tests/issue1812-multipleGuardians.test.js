'use strict';

/**
 * Tests for Issue #1812 — Multiple guardians per student with per-guardian
 * channel, language and quiet-hour preferences.
 *
 * Contract under test:
 *  - Student.guardians sub-document array with preference fields
 *  - Legacy parentEmail / parentPhone migrate into guardians[0]
 *  - Reminder fan-out honours each guardian's channels, locale, quiet hours and opt-out
 *  - Unsubscribe token identifies the guardian, not only the student
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSendEmail = jest.fn().mockResolvedValue({ delivered: true });
const mockSendSms = jest.fn().mockResolvedValue({ delivered: true });
const mockSendWhatsApp = jest.fn().mockResolvedValue({ delivered: true });
const mockIsSuppressed = jest.fn().mockResolvedValue(false);

jest.mock('../src/services/emailService', () => ({
  sendEmail: (...args) => mockSendEmail(...args),
}));
jest.mock('../src/services/smsService', () => ({
  sendSms: (...args) => mockSendSms(...args),
}));
jest.mock('../src/services/whatsappService', () => ({
  sendWhatsApp: (...args) => mockSendWhatsApp(...args),
}), { virtual: true });
jest.mock('../src/services/emailSuppressionService', () => ({
  isSuppressed: (...args) => mockIsSuppressed(...args),
}), { virtual: true });

const reminderService = require('../src/services/reminderService');
const {
  migrateLegacyGuardians,
  buildUnsubscribeToken,
  applyUnsubscribe,
} = require('../src/services/guardianService');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SCHOOL = { _id: 'school-1', emailLocale: 'en', settings: {} };

function makeStudent(overrides = {}) {
  return {
    _id: 'student-1',
    schoolId: 'school-1',
    name: 'Ada Eze',
    parentEmail: 'legacy@example.com',
    parentPhone: '+2348000000000',
    reminderOptOut: false,
    guardians: [
      {
        name: 'Mrs Eze',
        relationship: 'mother',
        email: 'mum@example.com',
        phone: '+2348011111111',
        preferredChannels: ['sms'],
        locale: 'ha',
        quietHours: { start: '20:00', end: '07:00' },
        receivesReminders: true,
        receivesReceipts: true,
        optedOutAt: null,
      },
      {
        name: 'Mr Eze',
        relationship: 'father',
        email: 'dad@example.com',
        phone: '+2348022222222',
        preferredChannels: ['email'],
        locale: 'en',
        quietHours: null,
        receivesReminders: true,
        receivesReceipts: false,
        optedOutAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Migration ─────────────────────────────────────────────────────────────────

describe('legacy parent fields migrate into guardians[0]', () => {
  it('creates a guardian from parentEmail and parentPhone when guardians is empty', () => {
    const student = makeStudent({ guardians: [] });

    const migrated = migrateLegacyGuardians(student);

    expect(migrated.guardians).toHaveLength(1);
    expect(migrated.guardians[0]).toEqual(
      expect.objectContaining({
        email: 'legacy@example.com',
        phone: '+2348000000000',
        receivesReminders: true,
        receivesReceipts: true,
      }),
    );
  });

  it('leaves an existing guardians array untouched', () => {
    const student = makeStudent();

    const migrated = migrateLegacyGuardians(student);

    expect(migrated.guardians).toHaveLength(2);
    expect(migrated.guardians[0].email).toBe('mum@example.com');
  });

  it('keeps legacy parentEmail / parentPhone populated for one release', () => {
    const student = makeStudent({ guardians: [] });

    const migrated = migrateLegacyGuardians(student);

    expect(migrated.parentEmail).toBe('legacy@example.com');
    expect(migrated.parentPhone).toBe('+2348000000000');
  });
});

// ── Per-guardian fan-out ──────────────────────────────────────────────────────

describe('reminder fan-out respects each guardian independently', () => {
  it('sends each reminding guardian only on their own preferred channel', async () => {
    await reminderService.sendReminderToGuardians(makeStudent(), SCHOOL, { amountDue: 5000 });

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+2348011111111' }),
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(0);
  });

  it('skips a guardian who opted out without silencing the other guardian', async () => {
    await reminderService.sendReminderToGuardians(makeStudent(), SCHOOL, { amountDue: 5000 });

    const emailRecipients = mockSendEmail.mock.calls.map((c) => c[0].to);
    expect(emailRecipients).not.toContain('dad@example.com');
    expect(mockSendSms).toHaveBeenCalled();
  });

  it('renders each message in that guardian\'s locale', async () => {
    await reminderService.sendReminderToGuardians(makeStudent(), SCHOOL, { amountDue: 5000 });

    expect(mockSendSms).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ha' }));
  });

  it('does not send to a guardian inside their quiet hours', async () => {
    const at2130 = new Date('2026-10-18T21:30:00+01:00');

    await reminderService.sendReminderToGuardians(makeStudent(), SCHOOL, {
      amountDue: 5000,
      now: at2130,
    });

    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('does not send to a guardian whose address is on the suppression list', async () => {
    mockIsSuppressed.mockImplementation(async (addr) => addr === 'mum@example.com');

    await reminderService.sendReminderToGuardians(makeStudent(), SCHOOL, { amountDue: 5000 });

    expect(mockSendSms).not.toHaveBeenCalled();
  });
});

// ── Unsubscribe token ─────────────────────────────────────────────────────────

describe('unsubscribe token identifies the guardian', () => {
  it('token resolves to the guardian and opts out only that guardian', async () => {
    const student = makeStudent();
    const token = buildUnsubscribeToken(student, student.guardians[0]);

    const updated = await applyUnsubscribe(token);

    expect(updated.guardians[0].optedOutAt).toBeInstanceOf(Date);
    expect(updated.guardians[1].optedOutAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });
});
