'use strict';

/**
 * Tests for ConcurrentPaymentProcessor queue depth / backpressure.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/services/transactionManager', () => ({
  transactionManager: {
    getActiveTransactionCount: jest.fn().mockReturnValue(0),
  },
}));

jest.mock('../backend/src/utils/logger', () => {
  // The real module does `module.exports = logger` AND `module.exports.logger =
  // logger`, so consumers use either `require(...).child()` (idempotencyStore) or
  // `const { logger } = require(...)` (concurrentPaymentProcessor). Replicate both,
  // else logger is undefined and logger.warn() throws on the QUEUE_FULL retry path.
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mockLogger),
  };
  mockLogger.logger = mockLogger;
  return mockLogger;
});

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn(),
}));

jest.mock('../backend/src/services/webhookService', () => ({
  sendPaymentWebhook: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const {
  ConcurrentPaymentProcessor,
  PaymentProcessingResult,
} = require('../backend/src/services/concurrentPaymentProcessor');

const Payment = require('../backend/src/models/paymentModel');
const Student = require('../backend/src/models/studentModel');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePaymentData(n) {
  return { memo: `STU00${n}`, senderAddress: 'GSENDER' };
}

function makeOptions(n) {
  return {
    studentId: `STU00${n}`,
    amount: 100,
    txHash: `txhash${n}`,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConcurrentPaymentProcessor – queue depth backpressure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No duplicate transactions by default
    Payment.findOne.mockResolvedValue(null);
  });

  describe('processPayment', () => {
    test('returns QUEUE_FULL when activeCount >= maxQueueDepth', async () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 1 });

      // Manually saturate the queue
      processor.activeCount = 1;

      const result = await processor.processPayment(makePaymentData(1), makeOptions(1));

      expect(result.success).toBe(false);
      expect(result.error.code).toBe('QUEUE_FULL');
    });

    test('allows processing when activeCount < maxQueueDepth', async () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 2 });
      processor.activeCount = 1;

      // Student not found → STUDENT_NOT_FOUND, but NOT QUEUE_FULL
      Student.findOne.mockResolvedValue(null);

      const result = await processor.processPayment(makePaymentData(1), makeOptions(1));

      expect(result.error.code).not.toBe('QUEUE_FULL');
    });

    test('decrements activeCount after processing (success path)', async () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 10 });

      Student.findOne.mockResolvedValue({
        studentId: 'STU001',
        feeAmount: 100,
        totalPaid: 0,
      });
      Student.findOneAndUpdate.mockResolvedValue({
        studentId: 'STU001',
        feeAmount: 100,
        totalPaid: 100,
        feePaid: true,
      });
      Payment.create.mockResolvedValue({ _id: 'pay1', txHash: 'txhash1' });

      expect(processor.activeCount).toBe(0);
      await processor.processPayment(makePaymentData(1), makeOptions(1));
      expect(processor.activeCount).toBe(0);
    });

    test('decrements activeCount after processing (error path)', async () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 10 });

      // Force an unexpected error
      Payment.findOne.mockRejectedValue(new Error('DB error'));

      await processor.processPayment(makePaymentData(1), makeOptions(1));
      expect(processor.activeCount).toBe(0);
    });
  });

  describe('getStats', () => {
    test('exposes queueDepth and maxQueueDepth', () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 42 });
      processor.activeCount = 7;

      const stats = processor.getStats();

      expect(stats.queueDepth).toBe(7);
      expect(stats.maxQueueDepth).toBe(42);
    });
  });

  describe('processBatch', () => {
    test('retries QUEUE_FULL items until they succeed', async () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 10 });

      // processPayment returns QUEUE_FULL on first call, succeeds on second
      const queueFullResult = new PaymentProcessingResult(
        false, {}, { message: 'Queue is full', code: 'QUEUE_FULL' }
      );
      const successResult = new PaymentProcessingResult(true, { payment: { _id: 'p1' } });

      const spy = jest
        .spyOn(processor, 'processPayment')
        .mockResolvedValueOnce(queueFullResult)
        .mockResolvedValueOnce(successResult);

      // Use 0ms retry delay so no fake timers are needed — the setTimeout fires
      // on the next event-loop tick and the await resolves normally.
      const batchResult = await processor.processBatch(
        [makePaymentData(1)],
        { ...makeOptions(1), queueFullRetryDelayMs: 0 }
      );

      expect(spy).toHaveBeenCalledTimes(2);
      expect(batchResult.successful).toBe(1);
      expect(batchResult.failed).toBe(0);
    });

    test('reports failure for non-QUEUE_FULL errors without retrying', async () => {
      const processor = new ConcurrentPaymentProcessor({ maxQueueDepth: 10 });

      const errorResult = new PaymentProcessingResult(
        false, {}, { message: 'Student not found', code: 'STUDENT_NOT_FOUND' }
      );

      const spy = jest
        .spyOn(processor, 'processPayment')
        .mockResolvedValue(errorResult);

      const batchResult = await processor.processBatch([makePaymentData(1)], makeOptions(1));

      // processPayment is called exactly once — no retry for non-QUEUE_FULL errors
      expect(spy).toHaveBeenCalledTimes(1);
      // The result is fulfilled (not thrown), so processBatch counts it as successful
      // at the Promise level; the caller must inspect result.data.success for details
      expect(batchResult.total).toBe(1);
      expect(batchResult.successful).toBe(1); // fulfilled promise
    });
  });
});
