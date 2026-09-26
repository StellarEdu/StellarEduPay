'use strict';

const receiptService = require('../backend/src/services/receiptService');

describe('Issue #1498: Receipt signature secret must be configured', () => {
  const originalEnv = process.env.RECEIPT_SIGNATURE_SECRET;

  afterEach(() => {
    if (originalEnv) {
      process.env.RECEIPT_SIGNATURE_SECRET = originalEnv;
    } else {
      delete process.env.RECEIPT_SIGNATURE_SECRET;
    }
  });

  test('generateReceiptSignature throws when RECEIPT_SIGNATURE_SECRET is not set', () => {
    delete process.env.RECEIPT_SIGNATURE_SECRET;

    const receipt = {
      txHash: 'test-hash',
      studentId: 'STU-001',
      schoolId: 'SCH-001',
      amount: 100,
      assetCode: 'XLM',
      confirmedAt: new Date(),
    };

    expect(() => receiptService.generateReceiptSignature(receipt)).toThrow(
      'RECEIPT_SIGNATURE_SECRET is not set. Cannot generate receipt signature.'
    );
  });

  test('generateReceiptSignature works with RECEIPT_SIGNATURE_SECRET set', () => {
    process.env.RECEIPT_SIGNATURE_SECRET = 'test-secret-key-minimum-32-chars!';

    const receipt = {
      txHash: 'test-hash',
      studentId: 'STU-001',
      schoolId: 'SCH-001',
      amount: 100,
      assetCode: 'XLM',
      confirmedAt: new Date('2024-01-01T00:00:00Z'),
    };

    const signature = receiptService.generateReceiptSignature(receipt);
    expect(signature).toBeDefined();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex is 64 chars
  });

  test('generateReceiptSignature produces consistent signatures', () => {
    process.env.RECEIPT_SIGNATURE_SECRET = 'test-secret-key-minimum-32-chars!';

    const receipt = {
      txHash: 'test-hash',
      studentId: 'STU-001',
      schoolId: 'SCH-001',
      amount: 100,
      assetCode: 'XLM',
      confirmedAt: new Date('2024-01-01T00:00:00Z'),
    };

    const signature1 = receiptService.generateReceiptSignature(receipt);
    const signature2 = receiptService.generateReceiptSignature(receipt);

    expect(signature1).toBe(signature2);
  });

  test('verifyReceiptSignature works with valid signature', () => {
    process.env.RECEIPT_SIGNATURE_SECRET = 'test-secret-key-minimum-32-chars!';

    const receipt = {
      txHash: 'test-hash',
      studentId: 'STU-001',
      schoolId: 'SCH-001',
      amount: 100,
      assetCode: 'XLM',
      confirmedAt: new Date('2024-01-01T00:00:00Z'),
    };

    const signature = receiptService.generateReceiptSignature(receipt);
    const receipt_with_sig = { ...receipt, signature };

    const isValid = receiptService.verifyReceiptSignature(receipt_with_sig);
    expect(isValid).toBe(true);
  });

  test('verifyReceiptSignature fails with invalid signature', () => {
    process.env.RECEIPT_SIGNATURE_SECRET = 'test-secret-key-minimum-32-chars!';

    const receipt = {
      txHash: 'test-hash',
      studentId: 'STU-001',
      schoolId: 'SCH-001',
      amount: 100,
      assetCode: 'XLM',
      confirmedAt: new Date('2024-01-01T00:00:00Z'),
      signature: 'invalid-signature-0000000000000000000000000000000000000000000000000000',
    };

    const isValid = receiptService.verifyReceiptSignature(receipt);
    expect(isValid).toBe(false);
  });

  test('different secrets produce different signatures', () => {
    const receipt = {
      txHash: 'test-hash',
      studentId: 'STU-001',
      schoolId: 'SCH-001',
      amount: 100,
      assetCode: 'XLM',
      confirmedAt: new Date('2024-01-01T00:00:00Z'),
    };

    process.env.RECEIPT_SIGNATURE_SECRET = 'secret-key-number-one-minimum-32!';
    const signature1 = receiptService.generateReceiptSignature(receipt);

    process.env.RECEIPT_SIGNATURE_SECRET = 'secret-key-number-two-minimum-32!';
    const signature2 = receiptService.generateReceiptSignature(receipt);

    expect(signature1).not.toBe(signature2);
  });
});
