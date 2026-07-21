'use strict';

/**
 * Tests for issue #798 — every reminder email must contain a signed
 * unsubscribe link, and the unsubscribe token must be verifiable.
 */

// ── Mocks (must be at top level for Jest hoisting) ────────────────────────────

jest.mock('../backend/src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// The email module checks the suppression list before sending; isSuppressed does
// EmailSuppression.findOne().lean() on a real model that never resolves with no
// DB, hanging the reminder send to timeout. Mock it to "not suppressed".
jest.mock('../backend/src/services/email/suppressionList', () => ({
  isSuppressed: jest.fn().mockResolvedValue(false),
}));

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'msg-1' });
const mockVerify = jest.fn().mockResolvedValue(true);
const mockTransporter = { sendMail: mockSendMail, verify: mockVerify };

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue(mockTransporter),
}), { virtual: true });

jest.mock('../backend/src/config', () => ({
  SMTP_HOST: 'smtp.test',
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_FROM: 'noreply@test.com',
  JWT_SECRET: 'test-secret-32-chars-long-xxxxxxxxxxx',
  APP_URL: 'http://localhost:5000',
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

const { generateUnsubscribeToken, verifyUnsubscribeToken } = require('../backend/src/utils/unsubscribeToken');

describe('#798 — unsubscribe token: sign and verify', () => {
  const SECRET = 'test-secret-32-chars-long-xxxxxxxxxxx';
  const studentId = 'STU001';
  const schoolId = 'SCH1';

  it('generates a token that verifies successfully', () => {
    const token = generateUnsubscribeToken(studentId, schoolId, SECRET);
    const result = verifyUnsubscribeToken(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.studentId).toBe(studentId);
    expect(result.schoolId).toBe(schoolId);
  });

  it('rejects a token signed with a different secret', () => {
    const token = generateUnsubscribeToken(studentId, schoolId, SECRET);
    expect(verifyUnsubscribeToken(token, 'wrong-secret').valid).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = generateUnsubscribeToken(studentId, schoolId, SECRET);
    const tampered = token.slice(0, -4) + 'XXXX';
    expect(verifyUnsubscribeToken(tampered, SECRET).valid).toBe(false);
  });

  it('rejects an expired token (91 days old)', () => {
    const crypto = require('crypto');
    const pastTs = Math.floor(Date.now() / 1000) - 91 * 24 * 60 * 60;
    const data = `${studentId}:${schoolId}:${pastTs}`;
    const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
    const expired = `${pastTs}.${sig}.${Buffer.from(studentId).toString('base64')}.${Buffer.from(schoolId).toString('base64')}`;
    const result = verifyUnsubscribeToken(expired, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });
});

describe('#798 — sendFeeReminder includes unsubscribe URL', () => {
  it('email bodies contain an unsubscribe link', async () => {
    const { sendFeeReminder } = require('../backend/src/services/notificationService');

    await sendFeeReminder({
      to: 'parent@test.com',
      studentName: 'Alice',
      studentId: 'STU001',
      schoolId: 'SCH1',
      className: 'Grade1',
      feeAmount: 500,
      remainingBalance: 500,
      schoolName: 'Test School',
      reminderCount: 1,
    });

    expect(mockSendMail).toHaveBeenCalled();
    const args = mockSendMail.mock.calls[0][0];
    expect(args.text).toMatch(/\/api\/reminders\/unsubscribe\?token=/);
    expect(args.html).toMatch(/unsubscribe/i);
  });
});
