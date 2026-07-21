'use strict';

/**
 * Tests that the idempotency middleware never serves a frozen
 * currency-conversion rate from a cached replay, independent of the 24h
 * idempotency-record TTL (IDEMPOTENCY_KEY_TTL_SECONDS).
 *
 * The `Payment.findOne` business-level cache in paymentController already
 * recomputes `localCurrency` fresh on every call. This suite covers the
 * *other* cache in front of `/api/payments/verify` — the HTTP
 * `Idempotency-Key` middleware, which stores the entire rendered response
 * body (including `localCurrency`) and, without the fix under test, would
 * replay that snapshot verbatim for up to IDEMPOTENCY_KEY_TTL_SECONDS.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

jest.mock('../src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn(),
}));

jest.mock('../src/services/idempotencyStore', () => ({
  getFull: jest.fn(),
  reserve: jest.fn(),
  complete: jest.fn(),
  release: jest.fn(),
  IN_FLIGHT_TTL_MS: 30000,
}));

const idempotency = require('../src/middleware/idempotency');
const idempotencyStore = require('../src/services/idempotencyStore');
const currencyConversionService = require('../src/services/currencyConversionService');

function makeRes() {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

async function flushPromises() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('idempotency middleware — currency rate freshness on replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('recomputes localCurrency on a cached replay instead of serving the frozen rate', async () => {
    const originalRateTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cachedBody = {
      verified: true,
      cached: true,
      hash: 'abc123',
      amount: 100,
      assetCode: 'XLM',
      localCurrency: {
        amount: 1200,
        currency: 'USD',
        rate: 12.0, // stale — the rate at the time of the ORIGINAL call
        rateTimestamp: originalRateTimestamp,
        available: true,
      },
    };

    // Well within the 24h idempotency TTL, so this record is still replayed —
    // it's the localCurrency block specifically that must not be frozen.
    idempotencyStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: null,
      responseStatus: 200,
      responseBody: cachedBody,
      scope: '/api/payments/verify',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The rate has since moved.
    currencyConversionService.convertToLocalCurrency.mockResolvedValue({
      available: true,
      localAmount: 1500,
      currency: 'USD',
      rate: 15.0,
      rateTimestamp: new Date().toISOString(),
    });

    const req = {
      headers: { 'idempotency-key': 'client-key-1' },
      path: '/api/payments/verify',
      body: { txHash: 'abc123' },
    };
    const res = makeRes();
    const next = jest.fn();

    idempotency(req, res, next);
    await flushPromises();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(currencyConversionService.convertToLocalCurrency).toHaveBeenCalledWith(100, 'XLM', 'USD');

    // The replayed response must carry the FRESH rate, not the one frozen at
    // cache-write time.
    expect(res.body.localCurrency.rate).toBe(15.0);
    expect(res.body.localCurrency.amount).toBe(1500);
    expect(res.body.localCurrency.rate).not.toBe(12.0);

    // Non-volatile fields are still served verbatim from the cached snapshot.
    expect(res.body.hash).toBe('abc123');
    expect(res.body.cached).toBe(true);
    expect(res.body.amount).toBe(100);
  });

  it('falls back to the cached rate when the refresh call fails', async () => {
    const cachedBody = {
      hash: 'def456',
      amount: 50,
      assetCode: 'XLM',
      localCurrency: {
        amount: 600,
        currency: 'USD',
        rate: 12.0,
        rateTimestamp: new Date().toISOString(),
        available: true,
      },
    };

    idempotencyStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: null,
      responseStatus: 200,
      responseBody: cachedBody,
      scope: '/api/payments/verify',
      createdAt: new Date(),
    });

    currencyConversionService.convertToLocalCurrency.mockRejectedValue(new Error('price feed down'));

    const req = {
      headers: { 'idempotency-key': 'client-key-2' },
      path: '/api/payments/verify',
      body: { txHash: 'def456' },
    };
    const res = makeRes();
    const next = jest.fn();

    idempotency(req, res, next);
    await flushPromises();

    // A refresh failure must not break the replay — the original cached rate
    // is served rather than a 500.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.localCurrency.rate).toBe(12.0);
  });

  it('leaves cached responses without localCurrency untouched', async () => {
    const cachedBody = { ok: true, orderId: 'o-1' };

    idempotencyStore.getFull.mockResolvedValue({
      state: 'completed',
      requestFingerprint: null,
      responseStatus: 201,
      responseBody: cachedBody,
      scope: '/api/payments/intent',
      createdAt: new Date(),
    });

    const req = {
      headers: { 'idempotency-key': 'client-key-3' },
      path: '/api/payments/intent',
      body: { studentId: 'STU001' },
    };
    const res = makeRes();
    const next = jest.fn();

    idempotency(req, res, next);
    await flushPromises();

    expect(currencyConversionService.convertToLocalCurrency).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toEqual(cachedBody);
  });
});
