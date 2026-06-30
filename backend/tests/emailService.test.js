'use strict';

/**
 * Tests for the unified email module (Issue #80):
 *   - external template rendering (receipt + reminder)
 *   - suppression list is honoured before sending
 *   - transient failures are retried, then surfaced after max attempts
 *   - provider factory selection
 *   - bounce/complaint webhook parsing (SES + SendGrid)
 */

// config/index.js requires MONGO_URI; we never connect, just need it present.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';

// Keep retry backoff effectively instant for the retry test.
process.env.EMAIL_RETRY_BASE_MS = '1';
process.env.EMAIL_RETRY_MAX_MS = '2';
process.env.EMAIL_MAX_RETRIES = '3';

const { renderEmailTemplate } = require('../src/utils/templateRenderer');

describe('templateRenderer / externalized templates', () => {
  test('renders receipt template with substitutions and conditional block', () => {
    const { text, html } = renderEmailTemplate('receiptEmail', {
      studentName: 'Ada Lovelace',
      amount: 150,
      txHash: 'abc123',
      confirmedAt: '2026-06-30T00:00:00.000Z',
      remainingBalance: 50,
    });
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('150');
    expect(text).toContain('abc123');
    expect(text).toContain('Remaining Balance');
    expect(html).toContain('<strong>150</strong>');
  });

  test('omits {{#if}} block when value is falsy', () => {
    const { text } = renderEmailTemplate('receiptEmail', {
      studentName: 'Grace',
      amount: 100,
      txHash: 'x',
      confirmedAt: 'now',
      remainingBalance: '', // paid in full
    });
    expect(text).not.toContain('Remaining Balance');
  });

  test('renders reminder template with unsubscribe link', () => {
    const { text, html } = renderEmailTemplate('reminderEmail', {
      studentName: 'Bob',
      studentId: 'S1',
      className: '5A',
      feeAmount: 200,
      outstanding: 200,
      schoolName: 'Test School',
      reminderNote: '',
      unsubscribeUrl: 'https://x/unsub?token=abc',
    });
    expect(text).toContain('Bob');
    expect(html).toContain('unsub?token=abc');
  });
});

describe('sendEmail', () => {
  const mockSend = jest.fn();
  const mockIsSuppressed = jest.fn();

  jest.mock('../src/services/email/emailProvider', () => ({
    getProvider: () => ({
      name: 'mock',
      send: (...a) => mockSend(...a),
      verify: async () => ({ ok: true }),
    }),
  }));
  jest.mock('../src/services/email/suppressionList', () => ({
    isSuppressed: (...a) => mockIsSuppressed(...a),
  }));

  let sendEmail;
  beforeAll(() => {
    sendEmail = require('../src/services/email').sendEmail;
  });

  beforeEach(() => {
    mockSend.mockReset();
    mockIsSuppressed.mockReset().mockResolvedValue(false);
  });

  test('skips and reports when no recipient', async () => {
    const res = await sendEmail({ subject: 'x' });
    expect(res).toEqual(expect.objectContaining({ sent: false, skipped: true }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('honours suppression list — never sends to suppressed address', async () => {
    mockIsSuppressed.mockResolvedValue(true);
    const res = await sendEmail({ to: 'bounced@example.com', subject: 'x', text: 'y' });
    expect(res).toEqual(expect.objectContaining({ sent: false, skipped: true, suppressed: true }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('sends on first try', async () => {
    mockSend.mockResolvedValue({ messageId: 'm1' });
    const res = await sendEmail({ to: 'a@example.com', subject: 's', text: 't' });
    expect(res).toEqual(expect.objectContaining({ sent: true, messageId: 'm1', attempts: 1 }));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('retries transient failure then succeeds', async () => {
    mockSend
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ messageId: 'm2' });
    const res = await sendEmail({ to: 'a@example.com', subject: 's', text: 't' });
    expect(res).toEqual(expect.objectContaining({ sent: true, messageId: 'm2', attempts: 2 }));
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('returns failure after exhausting retries', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    const res = await sendEmail({ to: 'a@example.com', subject: 's', text: 't' });
    expect(res.sent).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.error).toBe('boom');
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});

describe('emailProvider factory', () => {
  // sendEmail's describe mocks the provider module file-wide; use the real impl.
  const { resolveProviderName } = jest.requireActual('../src/services/email/emailProvider');
  const orig = { ...process.env };
  afterEach(() => {
    process.env.EMAIL_PROVIDER = orig.EMAIL_PROVIDER;
  });

  test('honours explicit EMAIL_PROVIDER', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    expect(resolveProviderName()).toBe('sendgrid');
  });

  test('falls back to console for unknown provider', () => {
    process.env.EMAIL_PROVIDER = 'pigeon';
    expect(resolveProviderName()).toBe('console');
  });
});

describe('webhook event parsing', () => {
  const { parseEvents } = require('../src/controllers/emailWebhookController');

  test('parses SES permanent bounce as hard', () => {
    const body = {
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@y.com', diagnosticCode: '550' }] },
      }),
    };
    const events = parseEvents('ses', body);
    expect(events).toEqual([
      expect.objectContaining({ email: 'x@y.com', kind: 'bounce', bounceType: 'hard' }),
    ]);
  });

  test('parses SES complaint', () => {
    const body = {
      Message: JSON.stringify({
        notificationType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'c@y.com' }], complaintFeedbackType: 'abuse' },
      }),
    };
    const events = parseEvents('ses', body);
    expect(events[0]).toEqual(expect.objectContaining({ email: 'c@y.com', kind: 'complaint' }));
  });

  test('parses SendGrid bounce + spamreport array', () => {
    const events = parseEvents('sendgrid', [
      { email: 'b@y.com', event: 'bounce', type: 'bounce', reason: 'mailbox unavailable' },
      { email: 's@y.com', event: 'spamreport' },
    ]);
    expect(events).toEqual([
      expect.objectContaining({ email: 'b@y.com', kind: 'bounce', bounceType: 'hard' }),
      expect.objectContaining({ email: 's@y.com', kind: 'complaint' }),
    ]);
  });
});
