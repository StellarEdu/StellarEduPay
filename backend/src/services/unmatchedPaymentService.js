'use strict';

/**
 * Records creditable school-wallet inflows that could not be matched to a
 * student (issue #1798), so the school can see and resolve them instead of the
 * money disappearing into a log line.
 */

const UnmatchedPayment = require('../models/unmatchedPaymentModel');

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Persist an unattributed payment. Idempotent: recording the same
 * { schoolId, txHash, opIndex } again leaves the existing document untouched.
 *
 * Errors other than a concurrent duplicate-key race are rethrown so the caller
 * does not advance its cursor past a payment that was never persisted.
 *
 * @returns {Promise<{ recorded: boolean }>}
 */
async function recordUnmatchedPayment({ schoolId, tx, payOp, memo, memoType, asset, opIndex = 0, reason }) {
  const key = { schoolId, txHash: tx.hash, opIndex };
  const fields = {
    amount: String(payOp.amount),
    assetCode: asset?.assetCode || (payOp.asset_type === 'native' ? 'XLM' : payOp.asset_code || null),
    memo: memo ?? null,
    memoType: memoType ?? null,
    senderAddress: payOp.from || null,
    ledger: tx.ledger_attr ?? null,
    reason,
    receivedAt: new Date(),
    status: 'open',
  };

  try {
    await UnmatchedPayment.updateOne(key, { $setOnInsert: fields }, { upsert: true });
    return { recorded: true };
  } catch (err) {
    if (err.code === DUPLICATE_KEY_ERROR) return { recorded: false };
    throw err;
  }
}

/**
 * List unmatched payments for a school, newest first.
 * @param {string} schoolId
 * @param {{ status?: string, limit?: number }} [options]
 */
async function listUnmatchedPayments(schoolId, { status = 'open', limit = 100 } = {}) {
  return UnmatchedPayment.find({ schoolId, status })
    .sort({ receivedAt: -1 })
    .limit(Math.min(limit, 500))
    .lean();
}

module.exports = { recordUnmatchedPayment, listUnmatchedPayments };
