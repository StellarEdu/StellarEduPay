'use strict';

/**
 * Tests for issue #800:
 *   - getRedisClient import no longer throws ReferenceError
 *   - recoverPendingJobs() re-enqueues pending/processing docs on startup
 */

// Set REDIS_HOST before module loads so transactionQueue initializes
process.env.REDIS_HOST = '127.0.0.1';

jest.mock('ioredis', () => {
  const EventEmitter = require('events');
  return jest.fn().mockImplementation(() => {
    const e = new EventEmitter();
    e.quit = jest.fn().mockResolvedValue('OK');
    return e;
  });
});

const mockQueueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd, close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
}));

const mockFindOneAndUpdate = jest.fn().mockResolvedValue(null);
const mockPendingDocs = [];
jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: (...a) => mockFindOneAndUpdate(...a),
  find: jest.fn().mockImplementation(() => ({
    bypassTenantScope: jest.fn().mockReturnThis(),
    lean: jest.fn().mockImplementation(() => Promise.resolve(mockPendingDocs.slice())),
  })),
}));

jest.mock('../backend/src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

const { recoverPendingJobs } = require('../backend/src/queue/transactionQueue');

beforeEach(() => {
  jest.clearAllMocks();
  mockQueueAdd.mockResolvedValue({ id: 'job-1' });
  mockFindOneAndUpdate.mockResolvedValue(null);
  mockPendingDocs.length = 0;
});

describe('#800 — transactionQueue getRedisClient import', () => {
  it('loads without ReferenceError (getRedisClient was missing)', () => {
    expect(() => require('../backend/src/queue/transactionQueue')).not.toThrow();
  });

  it('recoverPendingJobs re-enqueues in-flight jobs (restart survival)', async () => {
    mockPendingDocs.push(
      { txHash: 'in-flight-tx', schoolId: 'school-1', studentId: 'STU1', status: 'processing' }
    );

    const recovered = await recoverPendingJobs();

    expect(recovered).toBe(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'verify-transaction',
      expect.objectContaining({ txHash: 'in-flight-tx' }),
      expect.objectContaining({ jobId: 'in-flight-tx' })
    );
  });

  it('resets processing → pending before re-enqueuing', async () => {
    mockPendingDocs.push(
      { txHash: 'tx-proc', schoolId: 'school-1', studentId: null, status: 'processing' }
    );
    await recoverPendingJobs();
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { txHash: 'tx-proc', schoolId: 'school-1', status: 'processing' },
      { status: 'pending' }
    );
  });

  it('returns 0 when no unresolved jobs exist', async () => {
    const recovered = await recoverPendingJobs();
    expect(recovered).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
