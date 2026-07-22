'use strict';

/**
 * Regression test for a ReferenceError in the idempotency middleware's 5xx
 * path: `idempotencyStore.release(canonicalKey).catch(() => logger.debug(...))`
 * referenced a `logger` that was never defined in that scope (it only existed
 * inside a *different* .catch() callback a few lines up). Any release()
 * failure on a 5xx response therefore threw a ReferenceError from inside a
 * .catch() handler with nothing further to catch it — an unhandled
 * rejection, which crashes the whole multi-tenant process under the
 * documented policy (docs/error-handling.md), over a request that was
 * already failing for one tenant.
 */

// The middleware's module-level `logger` is created once at require time via
// `.child(...)`; the factory must return the SAME object on every call so
// this test's assertions observe the calls the middleware actually made.
jest.mock('../src/utils/logger', () => {
  const singleton = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { child: () => singleton };
});

jest.mock('../src/services/idempotencyStore', () => ({
  getFull: jest.fn(),
  reserve: jest.fn(),
  complete: jest.fn(),
  release: jest.fn(),
  IN_FLIGHT_TTL_MS: 30000,
}));

jest.mock('../src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn(),
}));

const idempotency = require('../src/middleware/idempotency');
const idempotencyStore = require('../src/services/idempotencyStore');
const logger = require('../src/utils/logger').child();

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

describe('idempotency middleware — 5xx release-failure path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    idempotencyStore.getFull.mockResolvedValue(null);
    idempotencyStore.reserve.mockResolvedValue({ reserved: true });
  });

  it('does not throw a ReferenceError, and does not produce an unhandled rejection, when release() fails on a 5xx response', async () => {
    idempotencyStore.release.mockRejectedValue(new Error('mongo unavailable'));

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    const req = {
      headers: { 'idempotency-key': 'client-key-1' },
      path: '/api/payments/verify',
      body: { txHash: 'abc' },
    };
    const res = makeRes();
    const next = jest.fn();

    idempotency(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate the downstream controller failing with a 5xx, as Express does:
    // res.status(500).json(...). This invokes the middleware's intercepted
    // res.json, which is where the bug lived.
    res.status(500).json({ error: 'internal error' });
    await flushPromises();

    expect(idempotencyStore.release).toHaveBeenCalledWith(expect.any(String));

    // The fixed code logs via the properly-scoped module logger instead of
    // throwing a ReferenceError from inside the .catch() callback.
    expect(logger.debug).toHaveBeenCalledWith(
      '[Idempotency] release missed',
      expect.objectContaining({ error: 'mongo unavailable' })
    );

    process.removeListener('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
