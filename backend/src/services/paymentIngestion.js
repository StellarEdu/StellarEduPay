const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Student = require('../models/Student');
const PaymentIntent = require('../models/PaymentIntent');
const Transaction = require('../models/Transaction');
const { updateStudentBalance } = require('./stellarService');
const { withStudentLock } = require('./lockService');
const logger = require('../utils/logger');

/**
 * Resolve a memo/reference to a student.
 *
 * Order of resolution:
 *   1. Pending payment intent (memo === intent.memo)
 *   2. Any payment intent (memo === intent.memo)
 *   3. Student ID (memo === student.studentId)
 *   4. Soft-deleted student (memo === student.studentId, studentDeleted: true)
 *
 * @param {string|mongoose.Types.ObjectId} schoolId
 * @param {string} memo
 * @returns {Promise<{student: object|null, intent: object|null, studentDeleted: boolean}>}
 */
async function resolveReference(schoolId, memo) {
  if (!memo) {
    return { student: null, intent: null, studentDeleted: false };
  }

  const normalizedMemo = String(memo).trim();
  if (!normalizedMemo) {
    return { student: null, intent: null, studentDeleted: false };
  }

  // 1. Pending intent
  let intent = await PaymentIntent.findOne({
    schoolId,
    memo: normalizedMemo,
    status: 'pending',
  });

  // 2. Any intent
  if (!intent) {
    intent = await PaymentIntent.findOne({
      schoolId,
      memo: normalizedMemo,
    });
  }

  if (intent && intent.studentId) {
    const student = await Student.findOne({
      schoolId,
      studentId: intent.studentId,
    });
    if (student) {
      return { student, intent, studentDeleted: !!student.studentDeleted };
    }
  }

  // 3. Active student by studentId
  let student = await Student.findOne({
    schoolId,
    studentId: normalizedMemo,
    studentDeleted: { $ne: true },
  });
  if (student) {
    return { student, intent: intent || null, studentDeleted: false };
  }

  // 4. Soft-deleted student
  student = await Student.findOne({
    schoolId,
    studentId: normalizedMemo,
    studentDeleted: true,
  });
  if (student) {
    return { student, intent: intent || null, studentDeleted: true };
  }

  return { student: null, intent: intent || null, studentDeleted: false };
}

/**
 * Determine whether an operation is creditable (a payment to the school).
 */
function isCreditableOperation(op, school) {
  if (!op) return false;
  if (op.type && op.type !== 'payment') return false;
  if (op.asset_code && school && school.assetCode && op.asset_code !== school.assetCode) {
    return false;
  }
  if (op.asset_issuer && school && school.assetIssuer && op.asset_issuer !== school.assetIssuer) {
    return false;
  }
  const amount = parseFloat(op.amount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return true;
}

/**
 * Extract the list of operations from a transaction-like object.
 */
function extractOperations(tx) {
  if (Array.isArray(tx.operations) && tx.operations.length > 0) {
    return tx.operations;
  }
  if (tx.operation) {
    return [tx.operation];
  }
  // Fall back to a synthetic operation built from the tx itself.
  return [
    {
      type: tx.type || 'payment',
      amount: tx.amount,
      asset_code: tx.assetCode || tx.asset_code,
      asset_issuer: tx.assetIssuer || tx.asset_issuer,
      from: tx.from,
      to: tx.to,
      memo: tx.memo,
    },
  ];
}

/**
 * Extract the memo from a transaction-like object.
 */
function extractMemo(tx) {
  if (tx.memo) return tx.memo;
  if (tx.operation && tx.operation.memo) return tx.operation.memo;
  if (Array.isArray(tx.operations)) {
    for (const op of tx.operations) {
      if (op && op.memo) return op.memo;
    }
  }
  return null;
}

/**
 * Record a transaction for a school, writing one Payment row per creditable
 * operation. Runs inside a single Mongo transaction, guarded by a per-student
 * distributed lock.
 *
 * @param {object} tx - transaction-like object (hash, ledger, operations, memo, ...)
 * @param {object} school - school document
 * @param {object} options
 * @param {string} options.source - 'sync' | 'poller' | 'stream' | 'verify' | 'retry'
 * @returns {Promise<{payments: object[], student: object|null, skipped: boolean, reason?: string}>}
 */
async function recordTransaction(tx, school, { source = 'unknown' } = {}) {
  if (!tx || !school) {
    throw new Error('recordTransaction requires a transaction and a school');
  }

  const schoolId = school._id || school.id;
  const txHash = tx.hash || tx.txHash || tx.transactionHash;
  if (!txHash) {
    throw new Error('recordTransaction requires a transaction hash');
  }

  const memo = extractMemo(tx);
  const { student, intent, studentDeleted } = await resolveReference(schoolId, memo);

  if (!student) {
    logger.warn('paymentIngestion: student not found', {
      source,
      schoolId: String(schoolId),
      txHash,
      memo,
    });
    return { payments: [], student: null, skipped: true, reason: 'student_not_found' };
  }

  const operations = extractOperations(tx);
  const creditableOps = operations.filter((op) => isCreditableOperation(op, school));

  if (creditableOps.length === 0) {
    logger.info('paymentIngestion: no creditable operations', {
      source,
      schoolId: String(schoolId),
      txHash,
    });
    return { payments: [], student, skipped: true, reason: 'no_creditable_operations' };
  }

  const studentKey = String(student._id);

  return withStudentLock(studentKey, async () => {
    const session = await mongoose.startSession();
    const createdPayments = [];
    let updatedStudent = student;

    try {
      await session.withTransaction(async () => {
        for (let i = 0; i < creditableOps.length; i += 1) {
          const op = creditableOps[i];
          const amount = parseFloat(op.amount);

          // Collision detection: same tx hash + operation index already recorded.
          const existing = await Payment.findOne({
            schoolId,
            txHash,
            operationIndex: i,
          }).session(session);

          if (existing) {
            logger.info('paymentIngestion: duplicate payment skipped', {
              source,
              schoolId: String(schoolId),
              txHash,
              operationIndex: i,
            });
            continue;
          }

          // Fee amount: intent amount, else student fee.
          const feeAmount =
            intent && typeof intent.amount === 'number'
              ? intent.amount
              : student.feeAmount || student.fee || 0;

          const payment = new Payment({
            schoolId,
            studentId: student.studentId,
            student: student._id,
            txHash,
            operationIndex: i,
            amount,
            assetCode: op.asset_code || school.assetCode,
            assetIssuer: op.asset_issuer || school.assetIssuer,
            from: op.from || tx.from,
            to: op.to || tx.to,
            memo: memo || null,
            feeAmount,
            source,
            confirmed: tx.successful !== false,
            confirmationState: tx.successful === false ? 'failed' : 'confirmed',
            ledger: tx.ledger || tx.ledgerSequence || null,
            studentDeleted: !!studentDeleted,
            intentId: intent ? intent._id : null,
            createdAt: new Date(),
          });

          await payment.save({ session });
          createdPayments.push(payment);
        }

        if (createdPayments.length > 0) {
          updatedStudent = await updateStudentBalance(student._id, session);

          if (intent && intent.status === 'pending') {
            intent.status = 'completed';
            intent.completedAt = new Date();
            intent.txHash = txHash;
            await intent.save({ session });
          }
        }
      });
    } catch (err) {
      logger.error('paymentIngestion: failed to record transaction', {
        source,
        schoolId: String(schoolId),
        txHash,
        error: err.message,
      });
      throw err;
    } finally {
      await session.endSession();
    }

    return {
      payments: createdPayments,
      student: updatedStudent,
      skipped: createdPayments.length === 0,
      reason: createdPayments.length === 0 ? 'duplicate_or_empty' : undefined,
    };
  });
}

module.exports = {
  resolveReference,
  recordTransaction,
  isCreditableOperation,
  extractOperations,
  extractMemo,
};