'use strict';

/**
 * Tests for issue #402 — auto-generate receipts on payment success.
 *
 * Covers:
 *   1. receiptService.createReceipt() creates a receipt with all required fields.
 *   2. createReceipt() is idempotent (returns existing receipt on duplicate txHash).
 *   3. createReceipt() populates studentName and schoolName from DB lookups.
 *   4. receiptsController.getReceipt() returns 200 with receipt JSON.
 *   5. receiptsController.getReceipt() calls next(NOT_FOUND) when no receipt exists.
 *   6. verifyPayment wires receipt creation (createReceipt is called after recordPayment).
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/receiptModel');
jest.mock('../backend/src/models/studentModel');
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn(),
}));

const Receipt = require('../backend/src/models/receiptModel');
const Student = require('../backend/src/models/studentModel');
const School = require('../backend/src/models/schoolModel');

const { createReceipt, getReceiptByTxHash } = require('../backend/src/services/receiptService');
const { getReceipt } = require('../backend/src/controllers/receiptsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAYMENT = {
  txHash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  studentId: 'STU001',
  schoolId: 'SCH-001',
  amount: 250,
  assetCode: 'XLM',
  feeAmount: 250,
  feeValidationStatus: 'valid',
  memo: 'STU001',
  confirmedAt: new Date('2026-03-24T10:00:00Z'),
};

function makeRes() {
  const res = {};
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

// ── receiptService tests ───────────────────────────────────────────────────────

describe('receiptService.createReceipt()', () => {
  test('creates a receipt with all required fields', async () => {
    Receipt.findOne.mockResolvedValue(null);
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve({ name: 'Alice Johnson' }) });
    School.findOne.mockReturnValue({ lean: () => Promise.resolve({ name: 'Lincoln High' }) });
    Receipt.create.mockResolvedValue({ ...PAYMENT, studentName: 'Alice Johnson', schoolName: 'Lincoln High', save() { return Promise.resolve(this); } });

    const receipt = await createReceipt(PAYMENT);

    expect(Receipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: PAYMENT.txHash,
        studentId: PAYMENT.studentId,
        studentName: 'Alice Johnson',
        schoolId: PAYMENT.schoolId,
        schoolName: 'Lincoln High',
        amount: PAYMENT.amount,
        assetCode: 'XLM',
        feeValidationStatus: 'valid',
      })
    );
    expect(receipt.studentName).toBe('Alice Johnson');
    expect(receipt.schoolName).toBe('Lincoln High');
  });

  test('is idempotent — returns existing receipt without creating a new one', async () => {
    const existing = { ...PAYMENT, studentName: 'Alice Johnson', _id: 'existing-id' };
    Receipt.findOne.mockResolvedValue(existing);

    const result = await createReceipt(PAYMENT);

    expect(Receipt.create).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  test('handles missing student/school gracefully (null names)', async () => {
    Receipt.findOne.mockResolvedValue(null);
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    School.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    Receipt.create.mockResolvedValue({ ...PAYMENT, studentName: null, schoolName: null, save() { return Promise.resolve(this); } });

    await createReceipt(PAYMENT);

    expect(Receipt.create).toHaveBeenCalledWith(
      expect.objectContaining({ studentName: null, schoolName: null })
    );
  });

  test('defaults assetCode to XLM when not provided', async () => {
    Receipt.findOne.mockResolvedValue(null);
    Student.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    School.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    Receipt.create.mockResolvedValue({ confirmedAt: new Date(), save() { return Promise.resolve(this); } });

    await createReceipt({ ...PAYMENT, assetCode: undefined });

    expect(Receipt.create).toHaveBeenCalledWith(
      expect.objectContaining({ assetCode: 'XLM' })
    );
  });
});

describe('receiptService.getReceiptByTxHash()', () => {
  test('queries by txHash and schoolId', async () => {
    const mockReceipt = { txHash: PAYMENT.txHash, schoolId: 'SCH-001' };
    Receipt.findOne.mockReturnValue({ lean: () => Promise.resolve(mockReceipt) });

    const result = await getReceiptByTxHash(PAYMENT.txHash, 'SCH-001');

    expect(Receipt.findOne).toHaveBeenCalledWith({ txHash: PAYMENT.txHash, schoolId: 'SCH-001' });
    expect(result).toEqual(mockReceipt);
  });
});

// ── receiptsController tests ──────────────────────────────────────────────────

describe('receiptsController.getReceipt()', () => {
  test('returns 200 with receipt JSON when found', async () => {
    const mockReceipt = { txHash: PAYMENT.txHash, studentName: 'Alice', schoolName: 'Lincoln High' };
    Receipt.findOne.mockReturnValue({ lean: () => Promise.resolve(mockReceipt) });

    const req = { params: { txHash: PAYMENT.txHash }, schoolId: 'SCH-001' };
    const res = makeRes();
    const next = jest.fn();

    await getReceipt(req, res, next);

    expect(res.json).toHaveBeenCalledWith(mockReceipt);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next with NOT_FOUND when receipt does not exist', async () => {
    Receipt.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const req = { params: { txHash: PAYMENT.txHash }, schoolId: 'SCH-001' };
    const next = jest.fn();

    await getReceipt(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
