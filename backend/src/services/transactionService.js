"use strict";

const Payment = require("../models/paymentModel");
const Outbox = require("../models/outboxModel");
const { generateReferenceCode } = require("../utils/generateReferenceCode");
const logger = require("../utils/logger").child("TransactionService");
const paymentEvents = require("../events/paymentEvents");
const { v4: uuidv4 } = require("uuid");

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
    const payment = await Payment.create(data, { session });

    const eventId = uuidv4();
    await Outbox.create({
      eventId,
      eventType: "payment.saved",
      aggregateId: payment.txHash,
      aggregateType: "payment",
      payload: payment.toObject(),
    }, { session });

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
 * Retrieve all payments for a given student, sorted by most recent first.
 */
async function getPaymentsByStudent(studentId) {
  return Payment.find({ studentId, deletedAt: null }).sort({ confirmedAt: -1 }).lean();
}

module.exports = { savePayment, getPaymentsByStudent };
