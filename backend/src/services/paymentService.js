const StellarSdk = require('@stellar/stellar-sdk');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const { server, getSchoolWallet } = require('../config/stellar');
const logger = require('../utils/logger');

const PAYMENT_TYPES = ['payment', 'path_payment_strict_send', 'path_payment_strict_receive'];

/**
 * Extract the credited amount from a Horizon operation.
 * For path payments the destination amount is the amount actually received
 * by the destination account, which is what should be credited.
 */
function getOperationAmount(op) {
  if (op.type === 'path_payment_strict_send' || op.type === 'path_payment_strict_receive') {
    return op.destination_amount || op.amount;
  }
  return op.amount;
}

/**
 * Extract the asset code from a Horizon operation.
 */
function getOperationAsset(op) {
  if (op.type === 'path_payment_strict_send' || op.type === 'path_payment_strict_receive') {
    return op.destination_asset_code || op.asset_code;
  }
  return op.asset_code;
}

/**
 * Resolve the student a payment operation should be credited to.
 *
 * A transaction carries a single memo, so when several payment operations
 * target the same school wallet we cannot rely on the memo alone to attribute
 * each operation. We therefore:
 *   - use the memo to resolve the intended student (single-student target),
 *   - fall back to the operation's own memo (if present),
 *   - otherwise leave the operation unattributed so it can be recorded as
 *     UNMATCHED and reconciled manually.
 */
async function resolveStudentForOperation(op, txMemo, schoolId) {
  const memo = op.memo || txMemo;
  if (!memo) return null;

  const student = await Student.findOne({ schoolId, studentId: memo });
  return student || null;
}

/**
 * Process a single payment operation and persist a payment record.
 *
 * The payment identity is (txHash, opIndex) so that multiple payment
 * operations inside the same transaction each get their own row.
 */
async function processPaymentOperation({ op, opIndex, txHash, txMemo, schoolId, walletAddress }) {
  const amount = getOperationAmount(op);
  const assetCode = getOperationAsset(op);

  if (!amount) {
    logger.warn(`Skipping operation ${opIndex} in tx ${txHash}: no amount`);
    return null;
  }

  const student = await resolveStudentForOperation(op, txMemo, schoolId);

  const paymentData = {
    schoolId,
    txHash,
    opIndex,
    amount,
    assetCode,
    from: op.from,
    to: op.to,
    walletAddress,
    status: student ? 'MATCHED' : 'UNMATCHED',
  };

  if (student) {
    paymentData.studentId = student.studentId;
    paymentData.student = student._id;
  }

  try {
    const payment = await Payment.create(paymentData);

    if (student) {
      await Student.updateOne(
        { _id: student._id },
        { $inc: { balance: parseFloat(amount) } }
      );
    } else {
      logger.warn(
        `Unmatched payment: tx ${txHash} op ${opIndex} amount ${amount} ${assetCode} ` +
        `to ${op.to} could not be attributed to a student`
      );
    }

    return payment;
  } catch (err) {
    if (err.code === 11000) {
      logger.info(`Payment already recorded: tx ${txHash} op ${opIndex}`);
      return null;
    }
    throw err;
  }
}

/**
 * Process a Stellar transaction, crediting every payment operation that
 * targets the school wallet.
 *
 * Previously only the first matching operation was considered
 * (`ops.records.find(...)`), which silently dropped the remaining operations
 * in a multi-operation transaction. We now iterate all payment-type
 * operations so no funds are lost.
 */
async function processTransaction(txHash, schoolId) {
  const walletAddress = await getSchoolWallet(schoolId);
  if (!walletAddress) {
    logger.warn(`No wallet configured for school ${schoolId}`);
    return [];
  }

  const tx = await server.transactions().transaction(txHash).call();
  const txMemo = tx.memo;

  const ops = await server.operations().forTransaction(txHash).call();

  const paymentOps = ops.records
    .map((op, index) => ({ op, opIndex: index }))
    .filter(({ op }) => PAYMENT_TYPES.includes(op.type) && op.to === walletAddress);

  if (paymentOps.length === 0) {
    return [];
  }

  const results = [];
  for (const { op, opIndex } of paymentOps) {
    const payment = await processPaymentOperation({
      op,
      opIndex,
      txHash,
      txMemo,
      schoolId,
      walletAddress,
    });
    if (payment) results.push(payment);
  }

  return results;
}

module.exports = {
  processTransaction,
  processPaymentOperation,
  getOperationAmount,
  getOperationAsset,
};
