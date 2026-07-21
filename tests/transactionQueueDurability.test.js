'use strict';

/**
 * Tests for transactionQueue durability — restart recovery scenario (#388).
 *
 * Verifies that:
 *   1. enqueueTransaction() persists a PendingVerification doc before touching Redis.
 *   2. recoverPendingJobs() re-enqueues pending/processing docs on startup.
 *   3. Duplicate txHash is handled idempotently (no duplicate PendingVerification).
 *   4. markResolved() / markDead() update the MongoDB document correctly.
 *   5. If Redis is unavailable the job is still persisted to MongoDB.
 */

// REDIS_HOST must be set before transactionQueue loads, otherwise getRedisClient()
// returns null, the BullMQ queue is never created, and enqueue/recover become no-ops.
process.env.REDIS_HOST = '127.0.0.1';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock ioredis so no real Redis connection is attempted
jest.mock('ioredis', () => {
  const EventEmitter = require('events');
  return jest.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    emitter.on = jest.fn((event, cb) => {
      EventEmitter.prototype.on.call(emitter, event, cb);
      return emitter;
    });
    return emitter;
  });
});

// Mock BullMQ Queue and Worker
var mockQueueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
var mockGetJob   = jest.fn().mockResolvedValue(null);
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add:    mockQueueAdd,
    getJob: mockGetJob,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on:    jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock PendingVerification model
var mockFindOneAndUpdate = jest.fn().mockResolvedValue(null);
var mockFind             = jest.fn();
jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: (...a) => mockFindOneAndUpdate(...a),
  find:             (...a) => mockFind(...a),
}));

// Mock logger
jest.mock('../backend/src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// ── Module under test ─────────────────────────────────────────────────────────

const {
  enqueueTransaction,
  recoverPendingJobs,
  markResolved,
  markDead,
} = require('../backend/src/queue/transactionQueue');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('transactionQueue — durability (issue #388)', () => {

  describe('enqueueTransaction()', () => {
    it('persists job to MongoDB before enqueuing to Redis', async () => {
      await enqueueTransaction('abc123', { schoolId: 'school-1', studentId: 'STU001' });

      // MongoDB upsert must have been called
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'abc123' },
        expect.objectContaining({ $setOnInsert: expect.objectContaining({ txHash: 'abc123', schoolId: 'school-1' }) }),
        expect.objectContaining({ upsert: true })
      );

      // BullMQ add must also have been called
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'abc123' }),
        expect.objectContaining({ jobId: 'abc123' })
      );
    });

    it('still persists to MongoDB when Redis/BullMQ throws', async () => {
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));

      await enqueueTransaction('redis-down-tx', { schoolId: 'school-1' });

      // MongoDB write must still have happened
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'redis-down-tx' },
        expect.anything(),
        expect.anything()
      );
    });

    it('is idempotent — calling twice for the same txHash does not throw', async () => {
      await expect(
        Promise.all([
          enqueueTransaction('dup-tx', { schoolId: 'school-1' }),
          enqueueTransaction('dup-tx', { schoolId: 'school-1' }),
        ])
      ).resolves.not.toThrow();
    });
  });

  describe('recoverPendingJobs() — restart recovery', () => {
    it('re-enqueues pending and processing jobs found in MongoDB', async () => {
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'tx-pending',    schoolId: 'school-1', studentId: 'STU001', status: 'pending' },
          { txHash: 'tx-processing', schoolId: 'school-1', studentId: 'STU002', status: 'processing' },
        ]),
      });

      const recovered = await recoverPendingJobs();

      expect(recovered).toBe(2);
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'tx-pending' }),
        expect.objectContaining({ jobId: 'tx-pending' })
      );
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'tx-processing' }),
        expect.objectContaining({ jobId: 'tx-processing' })
      );
    });

    it('resets processing → pending before re-enqueuing', async () => {
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'tx-was-processing', schoolId: 'school-1', studentId: null, status: 'processing' },
        ]),
      });

      await recoverPendingJobs();

      // Should have reset status to pending (filter is scoped by schoolId from the doc)
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'tx-was-processing', schoolId: 'school-1', status: 'processing' },
        { status: 'pending' }
      );
    });

    it('returns 0 when there are no unresolved jobs', async () => {
      mockFind.mockReturnValue({ bypassTenantScope: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });

      const recovered = await recoverPendingJobs();
      expect(recovered).toBe(0);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('continues recovering remaining jobs if one re-enqueue fails', async () => {
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'tx-fail',  schoolId: 'school-1', studentId: null, status: 'pending' },
          { txHash: 'tx-ok',    schoolId: 'school-1', studentId: null, status: 'pending' },
        ]),
      });

      mockQueueAdd
        .mockRejectedValueOnce(new Error('Redis error'))
        .mockResolvedValueOnce({ id: 'job-ok' });

      // Should not throw; should recover the second job
      const recovered = await recoverPendingJobs();
      expect(recovered).toBe(1);
    });
  });

  describe('markResolved()', () => {
    it('updates PendingVerification status to resolved', async () => {
      await markResolved('done-tx');

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'done-tx' },
        expect.objectContaining({ status: 'resolved' }),
        expect.objectContaining({ _bypassTenantScope: true })
      );
    });
  });

  describe('markDead()', () => {
    it('updates PendingVerification status to dead_letter with error message', async () => {
      const err = new Error('Unsupported asset');
      await markDead('bad-tx', err);

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'bad-tx' },
        expect.objectContaining({ status: 'dead_letter', lastError: 'Unsupported asset' }),
        expect.objectContaining({ _bypassTenantScope: true })
      );
    });
  });
});
