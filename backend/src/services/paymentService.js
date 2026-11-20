const StellarSdk = require('@stellar/stellar-sdk');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const { server, getSchoolWallet } = require('../config/stellar');
const logger = require('../utils/logger');
const paymentIngestion = require('./paymentIngestion');

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
 * Delegates to the shared ingestion module so sync, poller, stream and verify
 * all interpret memos (including payment-intent memos) identically.
 */
async function resolveStudentForOperation(op, txMemo, schoolId) {
  const memo = op.memo || txMemo;
  if (!memo) return null;

  const reference = await paymentIngestion.resolveReference(schoolId, memo);
  return reference && reference.student ? reference.student : null;
}

/**
 * Process a single payment operation and persist a payment record.
 *
 * Delegates to the shared ingestion module so the payment row, balance lock,
 * balance update and intent completion are identical across every source.
 */
async function processPaymentOperation({ op, opIndex, txHash, txMemo, schoolId, walletAddress }) {
  const amount = getOperationAmount(op);
  const assetCode = getOperationAsset(op);

  if (!amount) {
    logger.warn(`Skipping operation ${opIndex} in tx ${txHash}: no amount`);
    return null;
  }

  const school = { _id: schoolId, schoolId, walletAddress };
  const tx = {
    hash: txHash,
    memo: txMemo,
    operations: [{ op, opIndex }],
  };

  const result = await paymentIngestion.recordTransaction(tx, school, { source: 'sync' });
  return result && result.payments && result.payments.length ? result.payments[0] : null;
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
/**
 * Fetch every operation of a transaction, following Horizon pagination.
 *
 * Horizon returns at most 10 operations per page by default, while a
 * transaction may contain up to 100 operations. We therefore page through
 * the results so operations beyond the first page are not missed.
 */
async function fetchAllOperations(txHash) {
  const operations = [];
  let page = await server.operations().forTransaction(txHash).limit(200).call();

  while (page && page.records) {
    operations.push(...page.records);
    if (typeof page.next !== 'function') break;
    page = await page.next();
  }

  return operations;
}

/**
 * Extract every creditable operation targeting the school wallet from a
 * transaction, preserving each operation's index within the transaction.
 *
 * This is the single source of truth for multi-operation crediting and is
 * reused by stellarService so extraction logic is not duplicated.
 */
async function extractCreditableOperations(txHash, walletAddress) {
  const records = await fetchAllOperations(txHash);

  return records
    .map((op, index) => ({ op, opIndex: index }))
    .filter(({ op }) => PAYMENT_TYPES.includes(op.type) && op.to === walletAddress);
}

async function processTransaction(txHash, schoolId) {
  const walletAddress = await getSchoolWallet(schoolId);
  if (!walletAddress) {
    logger.warn(`No wallet configured for school ${schoolId}`);
    return [];
  }

  const tx = await server.transactions().transaction(txHash).call();
  const txMemo = tx.memo;

  const paymentOps = await extractCreditableOperations(txHash, walletAddress);

  if (paymentOps.length === 0) {
    return [];
  }

  const school = { _id: schoolId, schoolId, walletAddress };
  const result = await paymentIngestion.recordTransaction(
    { hash: txHash, memo: txMemo, operations: paymentOps },
    school,
    { source: 'sync' }
  );

  return result && result.payments ? result.payments : [];
}

module.exports = {
  PAYMENT_TYPES,
  processTransaction,
  processPaymentOperation,
  extractCreditableOperations,
  fetchAllOperations,
  getOperationAmount,
  getOperationAsset,
};
