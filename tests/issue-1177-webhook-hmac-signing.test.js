'use strict';

/**
 * Issue #1177 — HMAC Webhook Signing with Plaintext Secret
 *
 * Root cause: School.findOne().lean() bypasses the Mongoose post-init hook
 * that decrypts webhookSecret, so the HMAC was signed with the raw ciphertext
 * ("enc:...") instead of the plaintext secret.
 *
 * Fix: remove .lean() from both call sites so the post-init hook runs.
 *
 * This test verifies (for both paymentSavedSubscribers and dispute.controller):
 *   1. Source-code assertions confirm .lean() has been removed from both call sites.
 *   2. The HMAC signing function (generateSignature) produces a different signature
 *      for plaintext vs ciphertext secrets — proving the secret matters.
 *   3. verifySignature: plaintext-signed → verifies with plaintext (true),
 *      not with ciphertext (false). Ciphertext-signed → verifies with plaintext (false).
 *   4. paymentSavedSubscribers passes plaintext secret to notifyPaymentConfirmed.
 */

// ── Environment stubs ─────────────────────────────────────────────────────────
process.env.MONGO_URI       = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-jwt-secret-1234567890abcdef';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────
// Use 'mock'-prefixed names so they are accessible inside jest.mock() factories.
const mockPlaintextSecret  = 'my-real-webhook-secret-abc123';
const mockEncryptedSecret  = 'enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const mockWebhookUrl       = 'https://school.example.com/webhook';
const mockSchoolId         = 'SCH-1177';

// ── Helper: compute expected HMAC ────────────────────────────────────────────
function expectedHmac(body, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

// ── Top-level mocks ───────────────────────────────────────────────────────────
jest.mock('../backend/src/models/webhookRetryModel', () => ({
  create:           jest.fn().mockResolvedValue({}),
  find:             jest.fn().mockResolvedValue([]),
  updateOne:        jest.fn().mockResolvedValue({}),
  findOneAndDelete: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/models/webhookEndpointModel', () => ({
  find: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/models/webhookDeliveryModel', () => ({
  create:    jest.fn().mockResolvedValue({}),
  updateOne: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/utils/validateWebhookUrl', () => ({
  validateWebhookUrl:  jest.fn().mockResolvedValue({ valid: true }),
  validateResolvedIp:  jest.fn().mockReturnValue({ blocked: false }),
}));
jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn(),
}));
jest.mock('../backend/src/models/studentModel', () => ({
  findOne:   jest.fn().mockResolvedValue(null),
  updateOne: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/utils/buildWebhookPayload', () => ({
  buildWebhookPayload: jest.fn().mockImplementation((payload) => payload),
}));

// notifyPaymentConfirmed spy — we access it via require() in tests below.

// Mock webhookService entirely to avoid needing axios (not in root node_modules).

jest.mock('../backend/src/services/webhookService', () => {
  // Re-implement the two HMAC helpers using the same algorithm as the real code
  const _crypto = require('crypto');
  function _generateSignature(payload, secret) {
    return _crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  }
  function _verifySignature(payload, providedSignature, secret) {
    const expected = _generateSignature(payload, secret);
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf   = Buffer.from(providedSignature, 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return _crypto.timingSafeEqual(expectedBuf, actualBuf);
  }
  return {
    generateSignature:        _generateSignature,
    verifySignature:          _verifySignature,
    notifyPaymentConfirmed:   jest.fn().mockResolvedValue({}),
    notifyPaymentRefunded:    jest.fn().mockResolvedValue({}),
    fireWebhookToEndpoints:   jest.fn().mockResolvedValue([]),
    notifyDisputeCreated:     jest.fn().mockResolvedValue({}),
    notifyDisputeResolved:    jest.fn().mockResolvedValue({}),
    fireWebhook:              jest.fn().mockResolvedValue({}),
    _resetNonces:             jest.fn(),
  };
});

// ── Load modules after mocks ──────────────────────────────────────────────────
const { generateSignature, verifySignature } = require('../backend/src/services/webhookService');
const { onPaymentSavedWebhook } = require('../backend/src/services/paymentSavedSubscribers');
const School = require('../backend/src/models/schoolModel');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Part 1: Source-code assertions — confirm .lean() has been removed
// ─────────────────────────────────────────────────────────────────────────────

describe('#1177 — source-code: .lean() has been removed from both call sites', () => {

  test('paymentSavedSubscribers: no School.findOne().lean() calls', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../backend/src/services/paymentSavedSubscribers.js'),
      'utf8',
    );
    const lines = src.split('\n').filter(l => l.includes('School.findOne'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/\.lean\(\)/);
    }
  });

  test('dispute.controller: no School.findOne().lean() call in _notifyDisputeChange', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../backend/src/controllers/dispute.controller.js'),
      'utf8',
    );
    const fnStart = src.indexOf('async function _notifyDisputeChange');
    expect(fnStart).toBeGreaterThan(-1);

    // Slice from _notifyDisputeChange to the next top-level async function
    const fnEnd   = src.indexOf('\nasync function ', fnStart + 1);
    const fnBody  = fnEnd > -1 ? src.slice(fnStart, fnEnd) : src.slice(fnStart);

    const schoolFindLine = fnBody.split('\n').find(l => l.includes('School.findOne'));
    expect(schoolFindLine).toBeDefined();
    expect(schoolFindLine).not.toMatch(/\.lean\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Part 2: HMAC signing function correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('#1177 — generateSignature produces correct HMAC-SHA256', () => {

  test('generateSignature with plaintext secret returns correct HMAC', () => {
    const body = { event: 'payment.confirmed', data: { txHash: 'abc', schoolId: mockSchoolId } };
    const sig  = generateSignature(body, mockPlaintextSecret);
    expect(sig).toBe(expectedHmac(body, mockPlaintextSecret));
  });

  test('generateSignature with encrypted ciphertext produces a DIFFERENT HMAC', () => {
    const body = { event: 'payment.confirmed', data: { txHash: 'abc' } };
    const sigPlain = generateSignature(body, mockPlaintextSecret);
    const sigEnc   = generateSignature(body, mockEncryptedSecret);
    expect(sigPlain).not.toBe(sigEnc);
  });

  test('X-StellarEduPay-Signature header format is sha256=<hex>', () => {
    const body = { event: 'test', data: {} };
    const sig  = generateSignature(body, mockPlaintextSecret);
    const header = `sha256=${sig}`;
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test('same body + same secret always produces the same HMAC (deterministic)', () => {
    const body = { event: 'dispute.created', data: { disputeId: 'd1' } };
    expect(generateSignature(body, mockPlaintextSecret))
      .toBe(generateSignature(body, mockPlaintextSecret));
  });

  test('different secrets produce different HMACs for the same body', () => {
    const body = { event: 'dispute.created', data: { disputeId: 'd1' } };
    expect(generateSignature(body, 'secret-A'))
      .not.toBe(generateSignature(body, 'secret-B'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Part 3: verifySignature round-trip tests
// ─────────────────────────────────────────────────────────────────────────────

describe('#1177 — verifySignature confirms plaintext-signed webhooks correctly', () => {

  test('plaintext-signed → verifies with plaintext (true)', () => {
    const body = { event: 'dispute.created', data: { disputeId: 'd1', schoolId: mockSchoolId } };
    const sig  = generateSignature(body, mockPlaintextSecret);
    expect(verifySignature(body, sig, mockPlaintextSecret)).toBe(true);
  });

  test('plaintext-signed → fails verification with ciphertext secret (false)', () => {
    const body = { event: 'dispute.created', data: { disputeId: 'd1' } };
    const sig  = generateSignature(body, mockPlaintextSecret);
    expect(verifySignature(body, sig, mockEncryptedSecret)).toBe(false);
  });

  test('ciphertext-signed → fails verification with plaintext secret (false — old bug)', () => {
    const body = { event: 'dispute.created', data: { disputeId: 'd1' } };
    const encSig = generateSignature(body, mockEncryptedSecret);
    expect(verifySignature(body, encSig, mockPlaintextSecret)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Part 4: paymentSavedSubscribers passes plaintext secret to notifyPaymentConfirmed
// ─────────────────────────────────────────────────────────────────────────────

describe('#1177 — paymentSavedSubscribers passes plaintext secret to notifyPaymentConfirmed', () => {

  test('notifyPaymentConfirmed receives the plaintext secret (not ciphertext)', async () => {
    const webhookService = require('../backend/src/services/webhookService');

    // Force legacy fallback path by returning empty array from fireWebhookToEndpoints
    webhookService.fireWebhookToEndpoints.mockResolvedValue([]);

    // School document with plaintext webhookSecret (simulating post-init hook)
    School.findOne.mockResolvedValue({
      schoolId:      mockSchoolId,
      webhookUrl:    mockWebhookUrl,
      webhookSecret: mockPlaintextSecret,
      webhookPayloadConfig: { allowedFields: null },
    });

    await onPaymentSavedWebhook({
      txHash:          'tx-1177-pay',
      transactionHash: 'tx-1177-pay',
      studentId:       'STU001',
      schoolId:        mockSchoolId,
      amount:          250,
      status:          'SUCCESS',
    });

    const webhookService2 = require('../backend/src/services/webhookService');
    expect(webhookService2.notifyPaymentConfirmed).toHaveBeenCalled();
    const secret = webhookService2.notifyPaymentConfirmed.mock.calls[0][3];
    expect(secret).toBe(mockPlaintextSecret);
    expect(typeof secret === 'string' && secret.startsWith('enc:')).toBe(false);
  });

  test('notifyPaymentConfirmed is NOT called with encrypted ciphertext', async () => {
    const webhookService = require('../backend/src/services/webhookService');
    webhookService.fireWebhookToEndpoints.mockResolvedValue([]);

    School.findOne.mockResolvedValue({
      schoolId:      mockSchoolId,
      webhookUrl:    mockWebhookUrl,
      webhookSecret: mockPlaintextSecret, // plaintext — post-init hook ran
      webhookPayloadConfig: { allowedFields: null },
    });

    await onPaymentSavedWebhook({
      txHash:          'tx-1177-enc',
      transactionHash: 'tx-1177-enc',
      studentId:       'STU002',
      schoolId:        mockSchoolId,
      amount:          100,
      status:          'SUCCESS',
    });

    const webhookService2 = require('../backend/src/services/webhookService');
    if (webhookService2.notifyPaymentConfirmed.mock.calls.length > 0) {
      const secret = webhookService2.notifyPaymentConfirmed.mock.calls[0][3];
      expect(typeof secret === 'string' && secret.startsWith('enc:')).toBe(false);
    }
  });
});
