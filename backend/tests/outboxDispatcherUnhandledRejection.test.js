'use strict';

/**
 * outboxDispatcher.js passes an async function straight to setInterval.
 * dispatchOutboxEvents() already wraps everything it currently awaits in a
 * top-level try/catch, but nothing enforced that invariant — and under the
 * documented crash-on-unhandled-rejection policy (docs/error-handling.md),
 * any gap in it takes down the whole multi-tenant process over a single
 * background job failure. This suite proves the setInterval boundary itself
 * now swallows a rejection even when the function's own internal handling
 * fails too (e.g. the logger call in its catch block throwing), which is the
 * realistic "we didn't foresee this" case the fix is meant to cover.
 */

const Outbox = require('../src/models/outboxModel');

jest.mock('../src/models/outboxModel', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/events/paymentEvents', () => ({
  emit: jest.fn(),
}));

// Simulates a log-transport failure specifically on dispatchOutboxEvents' own
// internal error log, so its returned promise rejects DESPITE its internal
// try/catch — the one way to exercise the new setInterval-level boundary.
const mockErrorLog = jest.fn((message) => {
  if (message === 'Outbox dispatch error') {
    throw new Error('log transport unavailable');
  }
});

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: mockErrorLog }),
}));

async function flushPromises() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('outboxDispatcher — setInterval unhandled-rejection boundary', () => {
  let startOutboxDispatcher;
  let stopOutboxDispatcher;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Outbox.find.mockReturnValue({
      limit: () => ({ sort: () => Promise.reject(new Error('mongo unavailable')) }),
    });
    ({ startOutboxDispatcher, stopOutboxDispatcher } = require('../src/services/outboxDispatcher'));
  });

  afterEach(() => {
    stopOutboxDispatcher();
    jest.useRealTimers();
  });

  it('does not produce an unhandled rejection when dispatchOutboxEvents itself rejects', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    jest.useFakeTimers();
    startOutboxDispatcher();
    jest.advanceTimersByTime(5000);
    jest.useRealTimers();

    await flushPromises();

    // The internal catch's own logging call threw (simulating the "we didn't
    // foresee this" failure mode) — proving dispatchOutboxEvents really did
    // reject this time, not just hit its normal internal safety net.
    expect(mockErrorLog).toHaveBeenCalledWith('Outbox dispatch error', expect.any(Object));
    // The setInterval-level boundary caught that rejection and logged it
    // instead of letting it escape as an unhandled rejection.
    expect(mockErrorLog).toHaveBeenCalledWith(
      'Outbox dispatch tick failed unexpectedly',
      expect.objectContaining({ error: 'log transport unavailable' })
    );

    process.removeListener('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
