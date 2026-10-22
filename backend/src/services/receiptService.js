'use strict';

const crypto = require('crypto');
const Receipt = require('../models/receiptModel');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');

/**
 * Convert an amount to a canonical stroop integer string.
 * Stroops are the smallest indivisible unit (1 XLM = 10^7 stroops).
 * Accepts numbers, numeric strings, or BigInt-ish values; returns a string
 * of digits (no sign, no decimal point) so float formatting differences
 * between writers cannot invalidate signatures.
 */
function toStroopsString(amount) {
  if (amount === null || amount === undefined) return '0';
  const str = String(amount).trim();
  if (str === '') return '0';
  // Handle scientific notation and decimals via a fixed-point expansion.
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!match) {
    // Fall back to a numeric conversion; if that fails, treat as zero.
    const num = Number(str);
    if (!Number.isFinite(num)) return '0';
    return toStroopsString(num.toFixed(7));
  }
  const sign = match[1] === '-' ? '-' : '';
  const intPart = match[2] || '0';
  const fracPart = match[3] || '';
  const exp = match[4] ? parseInt(match[4], 10) : 0;

  // Shift the decimal point by exp.
  let digits = intPart + fracPart;
  let pointPos = intPart.length + exp;
  if (pointPos < 0) {
    digits = '0'.repeat(-pointPos) + digits;
    pointPos = 0;
  }
  if (pointPos > digits.length) {
    digits = digits + '0'.repeat(pointPos - digits.length);
  }
  const whole = digits.slice(0, pointPos) || '0';
  const frac = digits.slice(pointPos);

  // Pad/truncate fractional part to 7 decimal places (stroops).
  const fracPadded = (frac + '0000000').slice(0, 7);
  const stroops = BigInt(whole) * 10000000n + BigInt(fracPadded || '0');
  return sign + stroops.toString();
}

/**
 * Build a canonical, deterministic payload for signing.
 * Keys are sorted, amounts are stroop integer strings, dates are ISO strings.
 */
function buildCanonicalPayload(receipt) {
  const confirmedAt = receipt.confirmedAt instanceof Date
    ? receipt.confirmedAt.toISOString()
    : new Date(receipt.confirmedAt).toISOString();

  const payload = {
    amount: toStroopsString(receipt.amount),
    assetCode: receipt.assetCode || 'XLM',
    confirmedAt,
    opIndex: Number.isInteger(receipt.opIndex) ? receipt.opIndex : 0,
    schoolId: String(receipt.schoolId),
    studentId: String(receipt.studentId),
    txHash: String(receipt.txHash),
  };

  // Sort keys deterministically.
  const sorted = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return sorted;
}

function generateReceiptSignature(receipt) {
  const payload = buildCanonicalPayload(receipt);
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
 * Create a receipt for a successful payment operation.
 * Idempotent — returns the existing receipt if one already exists for the
 * `{ schoolId, txHash, opIndex }` triple. The document is built and signed in
 * memory and inserted atomically with an upsert, so concurrent callers cannot
 * create duplicates or observe an unsigned receipt.
 *
 * @param {object} payment - Payment document or plain object with payment fields
 * @returns {Promise<object>} The receipt document
 */
async function createReceipt(payment) {
  const schoolId = payment.schoolId;
  const txHash = payment.txHash;
  const opIndex = Number.isInteger(payment.opIndex) ? payment.opIndex : 0;

  // Resolve student name and school name for the receipt
  const [student, school] = await Promise.all([
    Student.findOne({ schoolId, studentId: payment.studentId }).lean(),
    School.findOne({ schoolId }).lean(),
  ]);

  const confirmedAt = payment.confirmedAt || new Date();

  const doc = {
    txHash,
    opIndex,
    studentId: payment.studentId,
    studentName: student ? student.name : null,
    schoolId,
    schoolName: school ? school.name : null,
    amount: payment.amount,
    assetCode: payment.assetCode || 'XLM',
    feeAmount: payment.feeAmount || null,
    feeValidationStatus: payment.feeValidationStatus || 'unknown',
    memo: payment.memo || null,
    confirmedAt,
  };

  // Compute the signature in memory before the single insert.
  doc.signature = generateReceiptSignature(doc);

  const receipt = await Receipt.findOneAndUpdate(
    { schoolId, txHash, opIndex },
    { $setOnInsert: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return receipt;
}

/**
 * Retrieve a receipt by transaction hash, scoped to a school.
 *
 * @param {string} txHash
 * @param {string} schoolId
 * @param {number} [opIndex=0] - Operation index within the transaction
 * @returns {Promise<object|null>}
 */
async function getReceiptByTxHash(txHash, schoolId, opIndex = 0) {
  return Receipt.findOne({ txHash, schoolId, opIndex }).lean();
}

module.exports = {
  createReceipt,
  getReceiptByTxHash,
  generateReceiptSignature,
  verifyReceiptSignature,
};
