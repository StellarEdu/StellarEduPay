"use strict";

const Payment = require("../models/paymentModel");
const Outbox = require("../models/outboxModel");
const { generateReferenceCode } = require("../utils/generateReferenceCode");
const logger = require("../utils/logger").child("TransactionService");
const paymentEvents = require("../events/paymentEvents");
const { v4: uuidv4 } = require("uuid");
const paymentIngestion = require("./paymentIngestion");

/**
 * Write concern for financial writes ensuring durability across replica set failover.
 * Uses 'majority' write concern to guarantee writes are acknowledged by a majority
 * of replica set members, preventing data loss on primary failure.
 */
const FINANCIAL_WRITE_CONCERN = { w: 'majority', wtimeout: 5000 };

/**
 * Persist a payment record, idempotently keyed on (schoolId, txHash).
 *
 * Idempotency is guaranteed by the unique compound DB index {schoolId, txHash}.
 * We rely on that constraint directly instead of a findOne pre-check, which has a
 * TOCTOU race window between concurrent poller/verify paths processing the same tx.
 * When the DB rejects a duplicate (error 11000) we throw DUPLICATE_TX so callers
 * can handle it as a normal idempotency case rather than an unexpected error.
 *
 * Side effects (webhooks, receipts, etc) are recorded in the outbox and processed
 * asynchronously by the outbox dispatcher, ensuring atomic writes with at-least-once
 * delivery guarantees.
 *
 * Throws DUPLICATE_TX if the transaction was already recorded by any concurrent path.
 */
async function savePayment(data, options = {}) {
  const { session = null } = options;

  if (!data.referenceCode) {
    data = { ...data, referenceCode: await generateReferenceCode() };
  }
  try {
    const payment = await Payment.create(data, { session, writeConcern: FINANCIAL_WRITE_CONCERN });

    const eventId = uuidv4();
    await Outbox.create({
      eventId,
      eventType: "payment.saved",
      aggregateId: payment.txHash,
      aggregateType: "payment",
      payload: payment.toObject(),
    }, { session, writeConcern: FINANCIAL_WRITE_CONCERN });

    logger.debug("Payment saved with outbox event", {
      txHash: payment.txHash,
      correlationId: payment.correlationId,
      schoolId: payment.schoolId,
    });

    return payment;
  } catch (e) {
    if (e.code === 11000) {
      const txHash = data.txHash || data.transactionHash;
      const err = new Error(`Transaction ${txHash} has already been processed`);
      err.code = "DUPLICATE_TX";
      logger.warn("Duplicate transaction rejected (concurrent path)", {
        txHash,
        correlationId: data.correlationId,
        schoolId: data.schoolId,
      });
      throw err;
    }
    logger.error("Failed to record payment", {
      error: e.message,
      txHash: data.txHash || data.transactionHash,
      correlationId: data.correlationId,
      schoolId: data.schoolId,
    });
    throw e;
  }
}

/**
 * Retrieve all payments for a given student within a specific school, sorted by most recent first.
 * schoolId is required to prevent cross-tenant data leaks: studentId is only unique per school,
 * so two different schools can legitimately share the same studentId value.
 * @param {string} schoolId - Required tenant scope.
 * @param {string} studentId - Student identifier within the school.
 */
async function getPaymentsByStudent(schoolId, studentId) {
  if (!schoolId) {
    const err = new Error('schoolId is required for getPaymentsByStudent');
    err.code = 'MISSING_SCHOOL_ID';
    throw err;
  }
  return Payment.find({ schoolId, studentId, deletedAt: null }).sort({ confirmedAt: -1 }).lean();
}

/**
 * Resolve the student (or pending intent) a transaction's memo refers to.
 * Delegates to the shared ingestion module so verify, sync, poller and stream
 * all interpret memos identically (pending intent, then any intent, then
 * student ID, then soft-deleted student).
 *
 * @param {string} schoolId - Tenant scope.
 * @param {string} memo - Memo (or reference) attached to the transaction.
 */
async function resolveReference(schoolId, memo) {
  return paymentIngestion.resolveReference(schoolId, memo);
}

/**
 * Record a verified transaction using the shared ingestion pipeline.
 *
 * This replaces the previous verify-specific row construction and memo
 * resolution so that a transaction ingested through verify produces the same
 * Payment rows (fields and count) and the same Student balance as sync,
 * poller and stream. It also honours ingestStartsAt and the per-student
 * balance lock (#1026).
 *
 * @param {object} tx - Raw transaction (hash, memo, operations, ...).
 * @param {object} school - School document (schoolId, ingestStartsAt, ...).
 * @param {object} [options]
 * @param {string} [options.source='verify'] - Ingestion source label.
 */
async function recordPayment(tx, school, options = {}) {
  const { source = "verify" } = options;
  return paymentIngestion.recordTransaction(tx, school, { source });
}

module.exports = { savePayment, getPaymentsByStudent, resolveReference, recordPayment };
