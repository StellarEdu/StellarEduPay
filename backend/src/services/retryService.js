"use strict";

/**
 * Retry Service — Stellar Network Outage Recovery
 *
 * When a Stellar network call fails with a transient error, the transaction hash
 * is cached in MongoDB as a PendingVerification document (with schoolId so the
 * correct wallet is used on retry). This service runs on a configurable interval,
 * checks network reachability, and re-attempts verification with exponential backoff.
 */

const PendingVerification = require("../models/pendingVerificationModel");
const Payment = require("../models/paymentModel");
const School = require("../models/schoolModel");
const { verifyTransaction, recordPayment } = require("./stellarService");
const { server } = require("../config/stellarConfig");
const config = require("../config/index");
const { withStellarRetry } = require("../utils/withStellarRetry");
const logger = require("../utils/logger").child("RetryService");

const RETRY_INTERVAL_MS = config.RETRY_INTERVAL_MS;
const MAX_ATTEMPTS = config.RETRY_MAX_ATTEMPTS;

// Exponential backoff: 1m, 2m, 4m … capped at 60 minutes
function nextRetryDelay(attempts) {
  const delayMs = Math.min(Math.pow(2, attempts) * 60_000, 60 * 60_000);
  return new Date(Date.now() + delayMs);
}

async function isStellarReachable() {
  try {
    await withStellarRetry(
      () => server.ledgers().order("desc").limit(1).call(),
      { maxAttempts: 2, label: "isStellarReachable" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue a transaction hash for later retry.
 * schoolId is stored so the retry worker can use the right wallet address.
 *
 * @param {string}      txHash
 * @param {string|null} studentId
 * @param {string}      errorMessage
 * @param {string}      schoolId
 */
async function queueForRetry(
  txHash,
  studentId = null,
  errorMessage = "",
  schoolId,
) {
  await PendingVerification.findOneAndUpdate(
    { txHash, schoolId },
    {
      $setOnInsert: { txHash, studentId, schoolId },
      $set: {
        status: "pending",
        lastError: errorMessage,
        nextRetryAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
  logger.info("Queued transaction for retry", {
    txHash,
    schoolId,
    reason: errorMessage,
  });
}

let _running = false;
let _timer = null;

async function processPendingVerifications() {
  if (_running) return;
  _running = true;

  try {
    // Background worker: intentionally spans all schools to drain the retry queue.
    const due = await PendingVerification.find({
      status: "pending",
      nextRetryAt: { $lte: new Date() },
    }).bypassTenantScope().limit(50);

    if (due.length === 0) {
      _running = false;
      return;
    }

    const reachable = await isStellarReachable();
    if (!reachable) {
      logger.warn("Stellar network still unreachable — skipping batch");
      _running = false;
      return;
    }

    logger.info(`Processing ${due.length} pending verification(s)`);

    for (const item of due) {
      await PendingVerification.findOneAndUpdate(
        { _id: item._id, schoolId: item.schoolId },
        { status: "processing", lastAttemptAt: new Date(), $inc: { attempts: 1 } },
      );

      try {
        // Look up the school to get the correct wallet address for verification
        const school = await School.findOne({
          schoolId: item.schoolId,
          isActive: true,
        }).lean();
        if (!school) {
          await PendingVerification.findOneAndUpdate(
            { _id: item._id, schoolId: item.schoolId },
            { status: "dead_letter", lastError: `School ${item.schoolId} not found or inactive` },
          );
          continue;
        }

        const result = await verifyTransaction(
          item.txHash,
          school.stellarAddress,
        );

        if (!result) {
          await PendingVerification.findOneAndUpdate(
            { _id: item._id, schoolId: item.schoolId },
            {
              status: "dead_letter",
              lastError: "verifyTransaction returned null — transaction is permanently invalid",
            },
          );
          logger.warn("Dead-lettered transaction — permanently invalid", {
            txHash: item.txHash,
          });
          continue;
        }

        await recordPayment({
          schoolId: item.schoolId,
          studentId: result.studentId || result.memo,
          txHash: result.hash,
          transactionHash: result.hash,
          amount: result.amount,
          feeAmount: result.expectedAmount || result.feeAmount,
          feeValidationStatus: result.feeValidation.status,
          excessAmount: result.feeValidation.excessAmount || 0,
          status: "confirmed",
          memo: result.memo,
          confirmedAt: result.date ? new Date(result.date) : new Date(),
        });

        await PendingVerification.findOneAndUpdate(
          { _id: item._id, schoolId: item.schoolId },
          { status: "resolved", resolvedAt: new Date(), lastError: null },
        );

        logger.info("Transaction resolved", {
          txHash: item.txHash,
          attempts: item.attempts + 1,
        });
      } catch (err) {
        const attempts = item.attempts + 1;
        const isPermanentError = [
          "TX_FAILED",
          "MISSING_MEMO",
          "INVALID_DESTINATION",
          "UNSUPPORTED_ASSET",
          "DUPLICATE_TX",
        ].includes(err.code);
        const isStellarError =
          !err.code || err.code === "STELLAR_NETWORK_ERROR";

        if (isPermanentError || attempts >= MAX_ATTEMPTS) {
          await PendingVerification.findOneAndUpdate(
            { _id: item._id, schoolId: item.schoolId },
            { status: "dead_letter", lastError: err.message },
          );

          // Create a FAILED Payment audit record for on-chain failures
          if (err.code === "TX_FAILED") {
            await Payment.create({
              schoolId: item.schoolId,
              studentId: item.studentId || "unknown",
              txHash: item.txHash,
              transactionHash: item.txHash,
              amount: 0,
              status: "FAILED",
              feeValidationStatus: "unknown",
              confirmationStatus: "failed",
              confirmedAt: new Date(),
              suspicionReason: err.message,
            }).catch((e) => {
              if (e.code !== 11000)
                logger.error("Failed to record failed tx audit", {
                  txHash: item.txHash,
                  error: e.message,
                });
            });
          }

          logger.error("Dead-lettered transaction", {
            txHash: item.txHash,
            reason: isPermanentError ? "permanent error" : "max attempts reached",
            error: err.message,
            code: err.code,
          });
        } else if (isStellarError) {
          await PendingVerification.findOneAndUpdate(
            { _id: item._id, schoolId: item.schoolId },
            { status: "pending", lastError: err.message, nextRetryAt: nextRetryDelay(attempts) },
          );
          logger.warn("Rescheduled transaction after Stellar error", {
            txHash: item.txHash,
            attempt: attempts,
            error: err.message,
          });
        } else {
          await PendingVerification.findOneAndUpdate(
            { _id: item._id, schoolId: item.schoolId },
            { status: "pending", lastError: err.message, nextRetryAt: nextRetryDelay(attempts) },
          );
          logger.error("Unknown error processing transaction", {
            txHash: item.txHash,
            error: err.message,
            code: err.code,
          });
        }
      }
    }
  } catch (err) {
    logger.error("Unexpected error in processPendingVerifications", {
      error: err.message,
      stack: err.stack,
    });
  } finally {
    _running = false;
  }
}

function startRetryWorker() {
  if (_timer) return;
  logger.info(
    `Starting — interval: ${RETRY_INTERVAL_MS}ms, max attempts: ${MAX_ATTEMPTS}`,
  );
  processPendingVerifications();
  _timer = setInterval(processPendingVerifications, RETRY_INTERVAL_MS);
}

function stopRetryWorker() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info("Stopped");
  }
}

function isRetryWorkerRunning() {
  return _running;
}

module.exports = {
  queueForRetry,
  processPendingVerifications,
  isStellarReachable,
  startRetryWorker,
  stopRetryWorker,
  isRetryWorkerRunning,
};
