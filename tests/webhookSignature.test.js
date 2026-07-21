'use strict';

// #596 — verifySignature uses crypto.timingSafeEqual instead of string comparison

const crypto = require('crypto');

// The service posts via an axios instance (axios.create().post); make create()
// share the same post spy so `axios.post` (grabbed below) is what actually runs.
jest.mock('axios', () => {
  const post = jest.fn();
  return { post, create: () => ({ post }) };
});
jest.mock('../backend/src/models/webhookRetryModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockResolvedValue([]),
  updateOne: jest.fn().mockResolvedValue({}),
}));

// ─── Load service after mocks ─────────────────────────────────────────────────

const { generateSignature, verifySignature, fireWebhook } = require('../backend/src/services/webhookService');
const WebhookRetry = require('../backend/src/models/webhookRetryModel');

// Intercept axios.post on the instance the service already loaded
const axios = require('axios');
const mockAxiosPost = axios.post;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('#468 webhook HMAC signature', () => {
  const SECRET = 'test-webhook-secret-abc123';
  const URL = 'https://example.com/webhook';
  const EVENT = 'payment.confirmed';
  const PAYLOAD = { studentId: 'STU001', amount: 100 };

  beforeEach(() => {
    mockAxiosPost.mockClear();
    mockAxiosPost.mockResolvedValue({ status: 200 });
    WebhookRetry.create.mockClear();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('generateSignature', () => {
    it('produces a hex string', () => {
      const sig = generateSignature({ event: EVENT, data: PAYLOAD }, SECRET);
      expect(typeof sig).toBe('string');
      expect(sig).toMatch(/^[0-9a-f]+$/);
    });

    it('changes when payload changes', () => {
      const body = { event: EVENT, data: PAYLOAD };
      const sig1 = generateSignature(body, SECRET);
      const sig2 = generateSignature({ ...body, data: { ...PAYLOAD, amount: 999 } }, SECRET);
      expect(sig1).not.toBe(sig2);
    });

    it('changes when secret changes', () => {
      const body = { event: EVENT, data: PAYLOAD };
      const sig1 = generateSignature(body, SECRET);
      const sig2 = generateSignature(body, 'different-secret');
      expect(sig1).not.toBe(sig2);
    });

    it('matches manual HMAC-SHA256 computation', () => {
      const body = { event: EVENT, data: PAYLOAD };
      const expected = crypto.createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
      expect(generateSignature(body, SECRET)).toBe(expected);
    });
  });

  describe('verifySignature', () => {
    it('returns true for a valid signature', () => {
      const body = { event: EVENT, data: PAYLOAD };
      const sig = generateSignature(body, SECRET);
      expect(verifySignature(body, sig, SECRET)).toBe(true);
    });

    it('returns false for a tampered payload', () => {
      const body = { event: EVENT, data: PAYLOAD };
      const sig = generateSignature(body, SECRET);
      const tampered = { ...body, data: { ...PAYLOAD, amount: 0 } };
      expect(verifySignature(tampered, sig, SECRET)).toBe(false);
    });

    it('returns false for an invalid (wrong) signature', () => {
      const body = { event: EVENT, data: PAYLOAD };
      const wrongSig = generateSignature(body, 'wrong-secret');
      expect(verifySignature(body, wrongSig, SECRET)).toBe(false);
    });

    it('returns false for a signature of different length without calling timingSafeEqual', () => {
      const body = { event: EVENT, data: PAYLOAD };
      // A truncated hex string produces a shorter buffer
      const shortSig = 'abcd';
      expect(verifySignature(body, shortSig, SECRET)).toBe(false);
    });
  });

  describe('fireWebhook', () => {
    it('includes X-StellarEduPay-Signature header when secret is provided', async () => {
      await fireWebhook(URL, EVENT, PAYLOAD, SECRET);

      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      const [, body, config] = mockAxiosPost.mock.calls[0];

      expect(config.headers).toHaveProperty('X-StellarEduPay-Signature');
      const headerValue = config.headers['X-StellarEduPay-Signature'];
      expect(headerValue).toMatch(/^sha256=[0-9a-f]+$/);

      const expectedSig = `sha256=${generateSignature(body, SECRET)}`;
      expect(headerValue).toBe(expectedSig);
    });

    it('omits X-StellarEduPay-Signature header when no secret is provided', async () => {
      await fireWebhook(URL, EVENT, PAYLOAD);

      const [, , config] = mockAxiosPost.mock.calls[0];
      expect(config.headers).not.toHaveProperty('X-StellarEduPay-Signature');
    });

    it('returns success when webhook responds 2xx', async () => {
      const result = await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('queues for retry on failure and stores secret', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await fireWebhook(URL, EVENT, PAYLOAD, SECRET);

      expect(result.success).toBe(false);
      expect(result.queued).toBe(true);
      expect(WebhookRetry.create).toHaveBeenCalledWith(
        expect.objectContaining({ secret: SECRET }),
      );
    });
  });
});
