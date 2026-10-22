'use strict';

/**
 * Tests for issue #1797 — req.rawBody was a UTF-8 string copy of every JSON
 * body, even though only inbound webhook routes need the exact bytes.
 *
 * Acceptance criteria:
 * - req.rawBody is only captured on signature-verified webhook routes
 * - req.rawBody is a Buffer, so signatures are checked over the wire bytes
 * - A signed webhook whose body is not valid UTF-8 still verifies
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

jest.mock('../backend/src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

const { verifySendGridSignature } = require('../backend/src/services/email/webhookVerification');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

function signSendGrid(timestamp, bodyBytes) {
  const signer = crypto.createSign('SHA256');
  signer.update(Buffer.concat([Buffer.from(String(timestamp), 'utf8'), bodyBytes]));
  return signer.sign(privateKey).toString('base64');
}

describe('Issue #1797 — webhook signatures are verified over the raw bytes', () => {
  const timestamp = '1760000000';

  test('a signed body containing non-UTF-8 bytes verifies when passed as a Buffer', () => {
    // 0xff / 0xfe are never valid UTF-8, so a string round-trip would corrupt them
    const bodyBytes = Buffer.concat([
      Buffer.from('{"email":"parent@example.test","note":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    const signature = signSendGrid(timestamp, bodyBytes);

    const result = verifySendGridSignature({
      publicKey: publicKeyPem,
      signature,
      timestamp,
      rawBody: bodyBytes,
    });

    expect(result).toEqual({ valid: true });
  });

  test('a body with a tampered byte is rejected', () => {
    const bodyBytes = Buffer.from('{"amount":"10"}', 'utf8');
    const signature = signSendGrid(timestamp, bodyBytes);
    const tampered = Buffer.from('{"amount":"90"}', 'utf8');

    const result = verifySendGridSignature({
      publicKey: publicKeyPem,
      signature,
      timestamp,
      rawBody: tampered,
    });

    expect(result).toEqual({ valid: false, reason: 'INVALID_SENDGRID_SIGNATURE' });
  });

  test('string bodies still verify for existing callers', () => {
    const body = '{"event":"delivered"}';
    const signature = signSendGrid(timestamp, Buffer.from(body, 'utf8'));

    const result = verifySendGridSignature({
      publicKey: publicKeyPem,
      signature,
      timestamp,
      rawBody: body,
    });

    expect(result).toEqual({ valid: true });
  });

  test('a missing body is reported as MISSING_RAW_BODY', () => {
    const result = verifySendGridSignature({
      publicKey: publicKeyPem,
      signature: 'c2ln',
      timestamp,
      rawBody: undefined,
    });

    expect(result).toEqual({ valid: false, reason: 'MISSING_RAW_BODY' });
  });
});

describe('Issue #1797 — raw body capture is scoped to webhook routes', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../backend/src/app.js'), 'utf8');
  const parserBlock = appSource.match(/app\.use\(express\.json\(\{[\s\S]*?\}\)\);/)?.[0] || '';

  test('the JSON parser no longer converts every body into a UTF-8 string', () => {
    expect(parserBlock).not.toContain("buf.toString('utf8')");
    expect(parserBlock).toContain('req.rawBody = buf;');
  });

  test('the capture is gated on the inbound webhook route pattern', () => {
    expect(appSource).toMatch(/RAW_BODY_ROUTE_RE = \/\^\\\/api\\\/\(email-provider-webhook\|email\\\/webhooks\)/);
    expect(parserBlock).toContain('RAW_BODY_ROUTE_RE.test(req.originalUrl');
  });
});
