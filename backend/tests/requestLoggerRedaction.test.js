'use strict';

const { redact } = require('../src/middleware/requestLogger');

describe('requestLogger body redaction', () => {
  it('redacts password field from a login request body', () => {
    const body = { email: 'admin@example.com', password: 'super-secret' };
    const result = redact(body);
    expect(result.password).toBe('[REDACTED]');
    expect(result.email).toBe('admin@example.com');
  });

  it('redacts mfaCode and backupCode fields from an MFA verify request body', () => {
    const body = { mfaCode: '123456', backupCode: 'ABCD-1234' };
    const result = redact(body);
    expect(result.mfaCode).toBe('[REDACTED]');
    expect(result.backupCode).toBe('[REDACTED]');
  });

  it('redacts secret, token, and currentPassword fields', () => {
    const body = { secret: 'x', token: 'y', currentPassword: 'z' };
    const result = redact(body);
    expect(result.secret).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.currentPassword).toBe('[REDACTED]');
  });
});
