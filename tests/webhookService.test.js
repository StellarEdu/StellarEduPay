'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Jest hoists jest.mock() — variable must be prefixed with 'mock' to be accessible inside factory
const mockAxiosPost = jest.fn();
// The service sends via an axios instance (axios.create().post), so create()
// must return an object whose post is the same spy the tests assert on.
jest.mock('axios', () => ({ post: mockAxiosPost, create: () => ({ post: mockAxiosPost }) }));
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

jest.mock('../backend/src/models/webhookRetryModel', () => ({
  create: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  // Issue #74: pending retries are now claimed atomically via findOneAndUpdate
  // (lease model), and stuck leases are recovered the same way.
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/utils/validateWebhookUrl', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
  // Send-time SSRF re-check; { blocked: false } means the resolved IP is allowed.
  validateResolvedIp: jest.fn().mockReturnValue({ blocked: false }),
}));

jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const WebhookRetry = require('../backend/src/models/webhookRetryModel');
const {
  fireWebhook,
  retryWebhook,
  processPendingRetries,
  getBackoffDelay,
} = require('../backend/src/services/webhookService');

const BASE_DOC = {
  _id: 'retry-doc-id',
  url: 'https://example.com/webhook',
  event: 'payment.confirmed',
  payload: { studentId: 'STU001', amount: 200 },
  secret: null,
  deliveryId: 'delivery-abc',
  status: 'pending',
  attemptCount: 0,
  maxAttempts: 3,
  nextRetryAt: new Date(),
  lastError: null,
  errorLog: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  WebhookRetry.create.mockResolvedValue({ ...BASE_DOC });
  WebhookRetry.find.mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
  WebhookRetry.updateOne.mockResolvedValue({});
  // Default: nothing stuck and nothing pending to claim.
  WebhookRetry.findOneAndUpdate.mockResolvedValue(null);
});

// ─── getBackoffDelay ──────────────────────────────────────────────────────────

describe('getBackoffDelay', () => {
  test('attempt 0 → 1 minute', () => expect(getBackoffDelay(0)).toBe(60000));
  test('attempt 1 → 5 minutes', () => expect(getBackoffDelay(1)).toBe(300000));
  test('attempt 2 → 15 minutes', () => expect(getBackoffDelay(2)).toBe(900000));
  test('beyond max clamps to last delay', () => expect(getBackoffDelay(99)).toBe(900000));
});

// ─── fireWebhook — first delivery failure ────────────────────────────────────

describe('fireWebhook — delivery failure', () => {
  test('first failure creates a WebhookRetry record with attemptCount 0', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('connection refused'));

    const result = await fireWebhook('https://example.com/webhook', 'payment.confirmed', { studentId: 'STU001' });

    expect(result.success).toBe(false);
    expect(result.queued).toBe(true);
    expect(WebhookRetry.create).toHaveBeenCalledTimes(1);
    expect(WebhookRetry.create.mock.calls[0][0].attemptCount).toBe(0);
    expect(WebhookRetry.create.mock.calls[0][0].status).toBe('pending');
  });

  test('retry uses the same deliveryId as the original delivery', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('timeout'));
    const fixedId = 'fixed-delivery-id';

    const result = await fireWebhook('https://example.com/webhook', 'payment.confirmed', {}, null, fixedId);

    expect(result.deliveryId).toBe(fixedId);
    expect(WebhookRetry.create.mock.calls[0][0].deliveryId).toBe(fixedId);
  });
});

// ─── retryWebhook ─────────────────────────────────────────────────────────────

describe('retryWebhook', () => {
  test('successful retry marks status as succeeded', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    await retryWebhook({ ...BASE_DOC });

    expect(WebhookRetry.updateOne).toHaveBeenCalledWith(
      { _id: BASE_DOC._id },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'succeeded' }) }),
    );
  });

  test('after MAX_WEBHOOK_RETRIES failures the delivery is marked status: failed', async () => {
    mockAxiosPost.mockRejectedValue(new Error('still down'));

    await retryWebhook({ ...BASE_DOC, attemptCount: 2, maxAttempts: 3 });

    expect(WebhookRetry.updateOne).toHaveBeenCalledWith(
      { _id: BASE_DOC._id },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  test('retry with attempts remaining schedules next retry without setting status: failed', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('still down'));

    await retryWebhook({ ...BASE_DOC, attemptCount: 0, maxAttempts: 3 });

    const setFields = WebhookRetry.updateOne.mock.calls[0][1].$set;
    // When attempts remain the delivery is re-queued (status back to 'pending'),
    // never marked 'failed'.
    expect(setFields.status).not.toBe('failed');
    expect(setFields.nextRetryAt).toBeInstanceOf(Date);
  });

  test('X-StellarEduPay-Delivery-ID header stays the same across retries', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    await retryWebhook({ ...BASE_DOC, attemptCount: 1 });

    const headers = mockAxiosPost.mock.calls[0][2].headers;
    expect(headers['X-StellarEduPay-Delivery-ID']).toBe(BASE_DOC.deliveryId);
  });
});

// ─── processPendingRetries ────────────────────────────────────────────────────

describe('processPendingRetries', () => {
  test('processes pending retries and returns count', async () => {
    mockAxiosPost.mockResolvedValue({ status: 200 });
    // #74: recoverStuckLeases finds nothing (null), then one pending retry is
    // claimed atomically, then no more.
    WebhookRetry.findOneAndUpdate
      .mockResolvedValueOnce(null)              // recoverStuckLeases: none stuck
      .mockResolvedValueOnce({ ...BASE_DOC })   // claim one pending retry
      .mockResolvedValueOnce(null);             // no more pending

    const result = await processPendingRetries();
    expect(result.processed).toBe(1);
  });

  test('returns 0 when no retries are pending', async () => {
    // findOneAndUpdate returns null for both stuck-lease recovery and claiming.
    WebhookRetry.findOneAndUpdate.mockResolvedValue(null);
    const result = await processPendingRetries();
    expect(result.processed).toBe(0);
  });
});
