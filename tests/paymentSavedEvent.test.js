'use strict';

/**
 * Tests for the payment.saved event pipeline.
 *
 * Covers:
 *   1. transactionService.savePayment emits 'payment.saved' after a successful save.
 *   2. onPaymentSavedWebhook calls notifyPaymentConfirmed with the correct args.
 *   3. onPaymentSavedWebhook is a no-op when PAYMENT_WEBHOOK_URL is not set.
 *   4. onPaymentSavedReceipt calls createReceipt with the payment document.
 *   5. onPaymentSavedCancelReminder clears reminder fields when feePaid is true.
 *   6. onPaymentSavedCancelReminder does nothing when feePaid is false.
 *   7. registerPaymentSavedSubscribers wires all three handlers to the event bus.
 *   8. A subscriber error does not prevent other subscribers from running.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/models/schoolModel', () => ({ findOne: jest.fn() }));
jest.mock('../backend/src/models/studentModel');
// savePayment persists a transactional outbox event instead of emitting directly.
jest.mock('../backend/src/models/outboxModel', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../backend/src/services/webhookService', () => ({
  notifyPaymentConfirmed: jest.fn(),
  // #865 — the subscriber tries multi-endpoint dispatch first, then falls back
  // to the legacy single URL. Return [] so the legacy path (asserted below) runs.
  fireWebhookToEndpoints: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/services/receiptService', () => ({
  createReceipt: jest.fn(),
}));
jest.mock('../backend/src/utils/generateReferenceCode', () => ({
  generateReferenceCode: jest.fn().mockResolvedValue('REF-TEST-001'),
}));
jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const Payment = require('../backend/src/models/paymentModel');
const School  = require('../backend/src/models/schoolModel');
const Student = require('../backend/src/models/studentModel');
const { notifyPaymentConfirmed } = require('../backend/src/services/webhookService');
const { createReceipt }          = require('../backend/src/services/receiptService');

// Import the module under test AFTER mocks are set up
const {
  onPaymentSavedWebhook,
  onPaymentSavedReceipt,
  onPaymentSavedCancelReminder,
  registerPaymentSavedSubscribers,
} = require('../backend/src/services/paymentSavedSubscribers');

const paymentEvents = require('../backend/src/events/paymentEvents');
const { savePayment } = require('../backend/src/services/transactionService');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PAYMENT = {
  _id: 'pay-1',
  txHash: 'abc123',
  transactionHash: 'abc123',
  studentId: 'STU001',
  schoolId: 'SCH-001',
  amount: 250,
  feeValidationStatus: 'valid',
  feePaid: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Remove all listeners between tests to avoid cross-test pollution
  paymentEvents.removeAllListeners('payment.saved');
});

// ── 1. savePayment emits 'payment.saved' ──────────────────────────────────────

describe('transactionService.savePayment', () => {
  test('writes a payment.saved outbox event after a successful save', async () => {
    const Outbox = require('../backend/src/models/outboxModel');
    Payment.findOne.mockResolvedValue(null);
    // savePayment calls payment.toObject() for the outbox payload.
    Payment.create.mockResolvedValue({ ...PAYMENT, toObject: () => PAYMENT });

    await savePayment({ transactionHash: 'abc123', schoolId: 'SCH-001', studentId: 'STU001', amount: 250 });

    expect(Outbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'payment.saved',
        aggregateType: 'payment',
        payload: expect.objectContaining({ txHash: 'abc123', schoolId: 'SCH-001' }),
      }),
      expect.anything()
    );
  });

  test('does not emit payment.saved when Payment.create throws', async () => {
    Payment.findOne.mockResolvedValue(null);
    Payment.create.mockRejectedValue(new Error('DB error'));

    const listener = jest.fn();
    paymentEvents.on('payment.saved', listener);

    await expect(
      savePayment({ transactionHash: 'abc123', schoolId: 'SCH-001', studentId: 'STU001', amount: 250 })
    ).rejects.toThrow('DB error');

    expect(listener).not.toHaveBeenCalled();
  });
});

// ── 2 & 3. onPaymentSavedWebhook ─────────────────────────────────────────────

describe('onPaymentSavedWebhook', () => {
  test('calls notifyPaymentConfirmed with URL and school webhookSecret', async () => {
    process.env.PAYMENT_WEBHOOK_URL = 'https://school.example/webhook';
    School.findOne.mockReturnValue({ lean: () => Promise.resolve({ webhookSecret: 'secret-abc' }) });
    notifyPaymentConfirmed.mockResolvedValue({ success: true });

    await onPaymentSavedWebhook(PAYMENT);

    expect(notifyPaymentConfirmed).toHaveBeenCalledWith(
      'https://school.example/webhook',
      expect.objectContaining({ txHash: 'abc123', schoolId: 'SCH-001', studentId: 'STU001' }),
      null,
      'secret-abc'
    );

    delete process.env.PAYMENT_WEBHOOK_URL;
  });

  test('is a no-op when PAYMENT_WEBHOOK_URL is not set', async () => {
    delete process.env.PAYMENT_WEBHOOK_URL;

    await onPaymentSavedWebhook(PAYMENT);

    expect(notifyPaymentConfirmed).not.toHaveBeenCalled();
  });

  test('passes null secret when school is not found', async () => {
    process.env.PAYMENT_WEBHOOK_URL = 'https://school.example/webhook';
    School.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    notifyPaymentConfirmed.mockResolvedValue({ success: true });

    await onPaymentSavedWebhook(PAYMENT);

    expect(notifyPaymentConfirmed).toHaveBeenCalledWith(
      'https://school.example/webhook',
      expect.objectContaining({ txHash: 'abc123', schoolId: 'SCH-001', studentId: 'STU001' }),
      null,
      null
    );

    delete process.env.PAYMENT_WEBHOOK_URL;
  });
});

// ── 4. onPaymentSavedReceipt ──────────────────────────────────────────────────

describe('onPaymentSavedReceipt', () => {
  test('calls createReceipt with the payment document', async () => {
    createReceipt.mockResolvedValue({});

    await onPaymentSavedReceipt(PAYMENT);

    expect(createReceipt).toHaveBeenCalledWith(PAYMENT);
  });

  test('swallows errors so other subscribers are not affected', async () => {
    createReceipt.mockRejectedValue(new Error('receipt DB error'));

    await expect(onPaymentSavedReceipt(PAYMENT)).resolves.toBeUndefined();
  });
});

// ── 5 & 6. onPaymentSavedCancelReminder ──────────────────────────────────────

describe('onPaymentSavedCancelReminder', () => {
  test('clears reminderCount and lastReminderSentAt when feePaid is true', async () => {
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve({ feePaid: true }) });
    Student.updateOne.mockResolvedValue({});

    await onPaymentSavedCancelReminder(PAYMENT);

    expect(Student.updateOne).toHaveBeenCalledWith(
      { schoolId: PAYMENT.schoolId, studentId: PAYMENT.studentId },
      { $set: { reminderCount: 0, lastReminderSentAt: null } }
    );
  });

  test('does not update student when feePaid is false', async () => {
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve({ feePaid: false }) });

    await onPaymentSavedCancelReminder(PAYMENT);

    expect(Student.updateOne).not.toHaveBeenCalled();
  });

  test('does not update student when student is not found', async () => {
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await onPaymentSavedCancelReminder(PAYMENT);

    expect(Student.updateOne).not.toHaveBeenCalled();
  });

  test('swallows errors so other subscribers are not affected', async () => {
    Student.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('DB error')) });

    await expect(onPaymentSavedCancelReminder(PAYMENT)).resolves.toBeUndefined();
  });
});

// ── 7. registerPaymentSavedSubscribers wires all three ───────────────────────

describe('registerPaymentSavedSubscribers', () => {
  test('registers all three handlers on the payment.saved event', () => {
    registerPaymentSavedSubscribers();

    const listeners = paymentEvents.listeners('payment.saved');
    expect(listeners).toContain(onPaymentSavedWebhook);
    expect(listeners).toContain(onPaymentSavedReceipt);
    expect(listeners).toContain(onPaymentSavedCancelReminder);
  });
});

// ── 8. One subscriber failing does not block others ───────────────────────────

describe('subscriber isolation', () => {
  test('receipt and reminder subscribers still run when webhook subscriber throws', async () => {
    process.env.PAYMENT_WEBHOOK_URL = 'https://school.example/webhook';
    School.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('school lookup failed')) });
    createReceipt.mockResolvedValue({});
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve({ feePaid: true }) });
    Student.updateOne.mockResolvedValue({});

    // Run all three independently (as the event bus does)
    await Promise.all([
      onPaymentSavedWebhook(PAYMENT),
      onPaymentSavedReceipt(PAYMENT),
      onPaymentSavedCancelReminder(PAYMENT),
    ]);

    expect(createReceipt).toHaveBeenCalledWith(PAYMENT);
    expect(Student.updateOne).toHaveBeenCalled();

    delete process.env.PAYMENT_WEBHOOK_URL;
  });
});
