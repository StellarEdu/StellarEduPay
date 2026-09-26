'use strict';

const crypto = require('crypto');
const Receipt = require('../models/receiptModel');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');

function generateReceiptSignature(receipt) {
  const payload = {
    txHash: receipt.txHash,
    studentId: receipt.studentId,
    schoolId: receipt.schoolId,
    amount: receipt.amount,
    assetCode: receipt.assetCode,
    confirmedAt: receipt.confirmedAt.toISOString(),
  };
  const secret = process.env.RECEIPT_SIGNATURE_SECRET;
  if (!secret) {
    throw new Error('RECEIPT_SIGNATURE_SECRET is not set. Cannot generate receipt signature.');
  }
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

function verifyReceiptSignature(receipt) {
  if (!receipt.signature) return false;
  const expectedSignature = generateReceiptSignature(receipt);
  const actual   = Buffer.from(receipt.signature);
  const expected = Buffer.from(expectedSignature);
  // crypto.timingSafeEqual throws a RangeError when the two buffers have
  // different lengths.  A length mismatch is itself proof of a bad signature,
  // so we treat it as verification failure rather than letting it propagate.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Create a receipt for a successful payment.
 * Idempotent — returns the existing receipt if one already exists for txHash.
 *
 * @param {object} payment - Payment document or plain object with payment fields
 * @returns {Promise<object>} The receipt document
 */
async function createReceipt(payment) {
  const existing = await Receipt.findOne({ txHash: payment.txHash });
  if (existing) return existing;

  // Resolve student name and school name for the receipt
  const [student, school] = await Promise.all([
    Student.findOne({ schoolId: payment.schoolId, studentId: payment.studentId }).lean(),
    School.findOne({ schoolId: payment.schoolId }).lean(),
  ]);

  const receipt = await Receipt.create({
    txHash: payment.txHash,
    studentId: payment.studentId,
    studentName: student ? student.name : null,
    schoolId: payment.schoolId,
    schoolName: school ? school.name : null,
    amount: payment.amount,
    assetCode: payment.assetCode || 'XLM',
    feeAmount: payment.feeAmount || null,
    feeValidationStatus: payment.feeValidationStatus || 'unknown',
    memo: payment.memo || null,
    confirmedAt: payment.confirmedAt || new Date(),
  });

  receipt.signature = generateReceiptSignature(receipt);
  return receipt.save();
}

/**
 * Retrieve a receipt by transaction hash, scoped to a school.
 *
 * @param {string} txHash
 * @param {string} schoolId
 * @returns {Promise<object|null>}
 */
async function getReceiptByTxHash(txHash, schoolId) {
  return Receipt.findOne({ txHash, schoolId }).lean();
}

module.exports = {
  createReceipt,
  getReceiptByTxHash,
  generateReceiptSignature,
  verifyReceiptSignature,
};
