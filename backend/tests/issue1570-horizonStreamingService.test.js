'use strict';

/**
 * Tests for Issue #1570 — Horizon SSE streaming service
 * (horizonStreamingService: SchoolStream lifecycle, reconnect backoff,
 *  getStreamStatus, stopStreaming, _reconcileStreams).
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockSchoolFind;
let mockSchoolFindOne;
let mockSchoolUpdateOne;
let mockProcessTransaction;

// Fluent builder used by SchoolStream._connect()
// All methods are jest mocks so we can assert on calls.
const mockStreamStopFn = jest.fn();
const mockBuilder = {
  order:      jest.fn().mockReturnThis(),
  cursor:     jest.fn().mockReturnThis(),
  forAccount: jest.fn().mockReturnThis(),
  stream:     jest.fn().mockReturnValue(mockStreamStopFn),
};
const mockTransactions = jest.fn().mockReturnValue(mockBuilder);

jest.mock('../src/models/schoolModel', () => ({
  find:      (...a) => mockSchoolFind(...a),
  findOne:   (...a) => mockSchoolFindOne(...a),
  updateOne: (...a) => mockSchoolUpdateOne(...a),
}));

jest.mock('../src/services/transactionPollingService', () => ({
  processTransaction: (...a) => mockProcessTransaction(...a),
  pollAllSchools:     jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: { transactions: mockTransactions },
}));

jest.mock('../src/metrics', () => ({
  registry: { registerMetric: jest.fn(), getMetricsAsJSON: jest.fn().mockReturnValue([]) },
}), { virtual: true });

jest.mock('prom-client', () => ({
  Gauge:   jest.fn().mockImplementation(() => ({ set: jest.fn() })),
  Counter: jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
}));

jest.mock('../src/services/workerHeartbeat', () => ({
  markStarted:  jest.fn(),
  markStopped:  jest.fn(),
  WORKER_NAMES: { HORIZON_STREAMING: 'HORIZON_STREAMING' },
}));

jest.mock('../src/utils/logger', () => ({
  child: () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.useFakeTimers();

const { SchoolStream, getStreamStatus, stopStreaming, _reconcileStreams, _streams } =
  require('../src/services/horizonStreamingService');

// ── Helpers ───────────────────────────────────────────────────────────────────

let _schoolCounter = 0;
function makeSchool(overrides = {}) {
  _schoolCounter++;
  return {
    schoolId:       `school-${_schoolCounter}`,
    stellarAddress: `GTEST${String(_schoolCounter).padStart(51, '0')}`,
    syncCursor:     null,
    isActive:       true,
    ...overrides,
  };
}

function resetBuilderMocks() {
  mockBuilder.order.mockClear().mockReturnThis();
  mockBuilder.cursor.mockClear().mockReturnThis();
  mockBuilder.forAccount.mockClear().mockReturnThis();
  mockBuilder.stream.mockClear().mockReturnValue(mockStreamStopFn);
  mockStreamStopFn.mockClear();
}

// ─────────────────────────────────────────────────────────────────────────────
// SchoolStream — basic lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('SchoolStream lifecycle', () => {
  beforeEach(() => {
    resetBuilderMocks();
    mockSchoolFindOne  = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    mockSchoolUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    mockProcessTransaction = jest.fn().mockResolvedValue({ processed: true });
  });

  afterEach(() => jest.clearAllTimers());

  test('start() opens a stream via the Stellar SDK builder', () => {
    const school = makeSchool({ syncCursor: 'cursor-abc' });
    const stream = new SchoolStream(school);
    stream.start();

    expect(mockBuilder.stream).toHaveBeenCalledTimes(1);
    expect(mockBuilder.cursor).toHaveBeenCalledWith('cursor-abc');
    expect(stream._active).toBe(true);
  });

  test('start() does not call cursor when syncCursor is null', () => {
    resetBuilderMocks();
    const school = makeSchool({ syncCursor: null });
    const stream = new SchoolStream(school);
    stream.start();

    expect(mockBuilder.stream).toHaveBeenCalledTimes(1);
    expect(mockBuilder.cursor).not.toHaveBeenCalled();
  });

  test('stop() sets _active false and calls the stream stop function', () => {
    const stopFn = jest.fn();
    mockBuilder.stream.mockReturnValueOnce(stopFn);

    const school = makeSchool();
    const stream = new SchoolStream(school);
    stream.start();
    stream.stop();

    expect(stream._active).toBe(false);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  test('start() is idempotent — second call does not open a second stream', () => {
    resetBuilderMocks();
    const school = makeSchool();
    const stream = new SchoolStream(school);
    stream.start();
    stream.start();

    expect(mockBuilder.stream).toHaveBeenCalledTimes(1);
  });

  test('lagSeconds returns null before any message is received', () => {
    const stream = new SchoolStream(makeSchool());
    expect(stream.lagSeconds).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SchoolStream — _onMessage
// ─────────────────────────────────────────────────────────────────────────────

describe('SchoolStream._onMessage', () => {
  beforeEach(() => {
    resetBuilderMocks();
    mockSchoolFindOne   = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    mockSchoolUpdateOne = jest.fn().mockResolvedValue({});
    mockProcessTransaction = jest.fn().mockResolvedValue({ processed: true });
  });

  test('calls processTransaction and advances syncCursor', async () => {
    const school = makeSchool({ syncCursor: 'old-cursor' });
    const stream = new SchoolStream(school);
    stream._active = true;

    const tx = { hash: 'tx-hash-1', paging_token: 'new-cursor' };
    await stream._onMessage(tx);

    expect(mockProcessTransaction).toHaveBeenCalledTimes(1);
    expect(stream.syncCursor).toBe('new-cursor');
    expect(mockSchoolUpdateOne).toHaveBeenCalledWith(
      { schoolId: school.schoolId },
      { $set: { syncCursor: 'new-cursor' } }
    );
  });

  test('does not update cursor when paging_token matches current cursor', async () => {
    const school = makeSchool({ syncCursor: 'same-cursor' });
    const stream = new SchoolStream(school);
    stream._active = true;

    await stream._onMessage({ hash: 'tx-1', paging_token: 'same-cursor' });

    expect(mockSchoolUpdateOne).not.toHaveBeenCalled();
  });

  test('stops the stream when school becomes inactive mid-stream', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) });
    const stream = new SchoolStream(makeSchool());
    stream._active = true;
    const stopSpy = jest.spyOn(stream, 'stop');

    await stream._onMessage({ hash: 'tx-1', paging_token: 'cursor-1' });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(mockProcessTransaction).not.toHaveBeenCalled();
  });

  test('does not throw when processTransaction throws — stream continues', async () => {
    mockProcessTransaction = jest.fn().mockRejectedValue(new Error('process error'));
    const stream = new SchoolStream(makeSchool());
    stream._active = true;

    await expect(stream._onMessage({ hash: 'tx-1', paging_token: 'c1' })).resolves.not.toThrow();
  });

  test('ignores message when stream is not active', async () => {
    const stream = new SchoolStream(makeSchool());
    stream._active = false;

    await stream._onMessage({ hash: 'tx-1', paging_token: 'c1' });

    expect(mockProcessTransaction).not.toHaveBeenCalled();
    expect(mockSchoolFindOne).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SchoolStream — _onError and exponential backoff reconnect
// ─────────────────────────────────────────────────────────────────────────────

describe('SchoolStream._onError reconnect backoff', () => {
  afterEach(() => jest.clearAllTimers());

  test('schedules a reconnect timer after an error', () => {
    const stream = new SchoolStream(makeSchool());
    stream._active = true;
    stream._onError(new Error('connection closed'));

    expect(stream._reconnectTimer).not.toBeNull();
  });

  test('doubles the backoff delay on successive errors (capped at max)', () => {
    const stream = new SchoolStream(makeSchool());
    stream._active = true;

    const initial = stream._reconnectDelayMs;

    stream._onError(new Error('err-1'));
    const afterFirst = stream._reconnectDelayMs;
    expect(afterFirst).toBe(Math.min(initial * 2, 64000));

    // Re-activate so second error is processed.
    stream._active = true;
    stream._clearReconnectTimer(); // cancel outstanding timer before next error
    stream._onError(new Error('err-2'));
    const afterSecond = stream._reconnectDelayMs;
    expect(afterSecond).toBe(Math.min(afterFirst * 2, 64000));
  });

  test('does not schedule reconnect when stream is stopped', () => {
    const stream = new SchoolStream(makeSchool());
    stream._active = false;
    stream._onError(new Error('err'));

    expect(stream._reconnectTimer).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getStreamStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('getStreamStatus', () => {
  afterEach(() => _streams.clear());

  test('reports enabled flag and correct openStreams count', () => {
    _streams.clear();
    const status = getStreamStatus();
    expect(status).toHaveProperty('enabled');
    expect(status.openStreams).toBe(0);
    expect(status.streams).toHaveLength(0);
  });

  test('reports each open stream with schoolId', () => {
    const school = makeSchool();
    const stream = new SchoolStream(school);
    _streams.set(school.schoolId, stream);

    const status = getStreamStatus();
    expect(status.openStreams).toBe(1);
    expect(status.streams[0].schoolId).toBe(school.schoolId);

    _streams.delete(school.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stopStreaming — stops all currently-tracked open streams
// ─────────────────────────────────────────────────────────────────────────────

describe('stopStreaming', () => {
  afterEach(() => {
    _streams.clear();
    jest.clearAllTimers();
  });

  test('is safe to call when nothing is running', () => {
    expect(() => stopStreaming()).not.toThrow();
  });

  test('SchoolStream.stop() sets _active false and clears the stream', () => {
    // Test the stream-level stop behaviour which stopStreaming delegates to.
    const school = makeSchool();
    const stopFn = jest.fn();
    mockBuilder.stream.mockReturnValueOnce(stopFn);

    const stream = new SchoolStream(school);
    stream.start();
    stream.stop();

    expect(stream._active).toBe(false);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  test('after _reconcileStreams starts streams, stopping one does not affect others', async () => {
    const school1 = makeSchool();
    const school2 = makeSchool();
    mockSchoolFind = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([school1, school2]),
    });

    await _reconcileStreams();
    expect(_streams.size).toBe(2);

    // Manually stop one
    _streams.get(school1.schoolId).stop();
    expect(_streams.get(school2.schoolId)._active).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _reconcileStreams
// ─────────────────────────────────────────────────────────────────────────────

describe('_reconcileStreams', () => {
  beforeEach(() => {
    resetBuilderMocks();
    mockSchoolUpdateOne = jest.fn().mockResolvedValue({});
    mockProcessTransaction = jest.fn().mockResolvedValue({ processed: false });
  });

  afterEach(() => {
    _streams.clear();
    jest.clearAllTimers();
  });

  test('opens streams for new active schools', async () => {
    const school = makeSchool();
    mockSchoolFind = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([school]),
    });

    await _reconcileStreams();

    expect(_streams.has(school.schoolId)).toBe(true);
    expect(_streams.get(school.schoolId)._active).toBe(true);
  });

  test('does not open duplicate streams for an already-streaming school', async () => {
    const school = makeSchool();
    const existing = new SchoolStream(school);
    existing._active = true;
    _streams.set(school.schoolId, existing);

    mockSchoolFind = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([school]),
    });

    const startSpy = jest.spyOn(existing, 'start');
    await _reconcileStreams();

    expect(startSpy).not.toHaveBeenCalled();
    expect(_streams.size).toBe(1);
  });

  test('closes streams for schools no longer in the active list', async () => {
    const removed = makeSchool();
    const stream = new SchoolStream(removed);
    stream._active = true;
    _streams.set(removed.schoolId, stream);

    const stopSpy = jest.spyOn(stream, 'stop');

    // Active schools list is empty — all existing streams should be torn down.
    mockSchoolFind = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([]),
    });

    await _reconcileStreams();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(_streams.has(removed.schoolId)).toBe(false);
  });

  test('opens stream for new school while preserving existing one', async () => {
    const existing = makeSchool();
    const existingStream = new SchoolStream(existing);
    existingStream._active = true;
    _streams.set(existing.schoolId, existingStream);

    const newSchool = makeSchool();
    mockSchoolFind = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([existing, newSchool]),
    });

    const startSpy = jest.spyOn(existingStream, 'start');
    await _reconcileStreams();

    expect(startSpy).not.toHaveBeenCalled();            // existing unchanged
    expect(_streams.has(newSchool.schoolId)).toBe(true); // new one opened
    expect(_streams.size).toBe(2);
  });
});
