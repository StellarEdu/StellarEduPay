'use strict';

const mongoose = require('mongoose');
const School = require('../models/schoolModel');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const { server } = require('../config/stellarConfig');
const { extractValidPayment, validatePaymentAgainstFee, detectMemoCollision, detectCrossSchoolMemoCollision, detectAbnormalPatterns, determineConfirmationState } = require('./stellarService');
const { CONFIRMATION_STATES, isConfirmedOrAbove } = require('./paymentConfirmationStateMachine');
const { validatePaymentAmount } = require('../utils/paymentLimits');
const { generateReferenceCode } = require('../utils/generateReferenceCode');
const { emit: sseEmit } = require('./sseService');
const lock = require('./distributedLock');
const config = require('../config');
const logger = require('../utils/logger').child('TransactionPollingService');
const { deriveCorrelationId } = require('../utils/correlationId');
const { captureFiatSnapshot } = require('./currencyConversionService');

let pollingInterval = null;
let isPolling = false;

// Base poll interval, honoring SYNC_INTERVAL_MS from config (which itself falls
// back to POLL_INTERVAL_MS). A value of 0 disables auto-sync entirely.
const SYNC_INTERVAL_MS = config.SYNC_INTERVAL_MS;
// TTL of the per-school distributed sync lock (crash-safety net).
const SYNC_LOCK_TTL_MS = config.SYNC_LOCK_TTL_MS;
const TRANSACTIONS_PER_POLL = 20;

// Exponential backoff state — reset on first successful poll after errors.
// POLL_MAX_BACKOFF_MS defaults to 5 minutes; configurable via env var.
const POLL_MAX_BACKOFF_MS = parseInt(process.env.POLL_MAX_BACKOFF_MS || '300000', 10);
let consecutiveErrors = 0;
let currentIntervalMs = SYNC_INTERVAL_MS;

/**
 * Process a single transaction for a school
 */
async function processTransaction(tx, school) {
  const { schoolId, stellarAddress } = school;
  const correlationId = deriveCorrelationId(tx.hash);

  // Cheap optimisation only: skip work for transactions we've clearly already
  // recorded. This is NOT the dedup guarantee — it is a read-then-write race
  // (two workers can both miss the row). The authoritative guard is the unique
  // index on Payment { schoolId, txHash }, which makes the insert below fail
  // atomically with code 11000 if a concurrent worker won the race.
  const existing = await Payment.findOne({ schoolId, txHash: tx.hash, deletedAt: null });
  if (existing) {
    return { processed: false, reason: 'duplicate' };
  }

  // Extract and validate payment
  const valid = await extractValidPayment(tx, stellarAddress);
  if (!valid) {
    return { processed: false, reason: 'invalid_payment' };
  }

  const { payOp, memo, asset } = valid;
  const paymentAmount = parseFloat(payOp.amount);

  // Validate payment amount is within configured limits
  const limitValidation = validatePaymentAmount(paymentAmount);
  if (!limitValidation.valid) {
    logger.warn('Payment outside limits', {
      txHash: tx.hash,
      correlationId,
      schoolId,
      amount: paymentAmount,
      error: limitValidation.error
    });
    return { processed: false, reason: 'amount_limit_exceeded' };
  }

  // Find student by memo (studentId)
  const student = await Student.findOne({ schoolId, studentId: memo });
  if (!student) {
    logger.warn('Student not found for memo', { txHash: tx.hash, correlationId, schoolId, memo });
    return { processed: false, reason: 'student_not_found' };
  }

  const senderAddress = payOp.from || null;
  const txDate = new Date(tx.created_at);
  const txLedger = tx.ledger_attr || tx.ledger || null;

  // Check for suspicious activity
  const collision = await detectMemoCollision(memo, senderAddress, paymentAmount, student.feeAmount, txDate, schoolId);
  const crossSchoolCollision = await detectCrossSchoolMemoCollision(memo, schoolId, txDate);
  const abnormal = await detectAbnormalPatterns(senderAddress, paymentAmount, student.feeAmount, txDate, schoolId, school.suspiciousPaymentMultiplier, school.suspiciousAmountConfig);

  const isSuspicious = collision.suspicious || crossSchoolCollision.suspicious || abnormal.suspicious;
  const suspicionReason = [collision.reason, crossSchoolCollision.reason, abnormal.reason].filter(Boolean).join('; ') || null;

  if (isSuspicious) {
    try {
      require('../metrics').suspiciousPaymentFlagged.inc({ school_id: schoolId });
    } catch (_) {
      // metrics module unavailable — flagging still proceeds
    }
  }

  const confirmation = await determineConfirmationState(
    txLedger,
    CONFIRMATION_STATES.DETECTED,
    isSuspicious,
  );
  const isConfirmed = isConfirmedOrAbove(confirmation.state);
  const confirmationStatus = confirmation.confirmationStatus;

  // Calculate cumulative totals
  const previousPayments = await Payment.aggregate([
    { $match: { schoolId, studentId: memo, confirmationStatus: 'confirmed', isSuspicious: false, deletedAt: null } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const previousTotal = previousPayments.length ? previousPayments[0].total : 0;
  const cumulativeTotal = parseFloat((previousTotal + paymentAmount).toFixed(7));
  const remaining = parseFloat((student.feeAmount - cumulativeTotal).toFixed(7));

  let cumulativeStatus;
  if (cumulativeTotal < student.feeAmount) cumulativeStatus = 'underpaid';
  else if (cumulativeTotal > student.feeAmount) cumulativeStatus = 'overpaid';
  else cumulativeStatus = 'valid';

  const excessAmount = cumulativeStatus === 'overpaid'
    ? parseFloat((cumulativeTotal - student.feeAmount).toFixed(7))
    : 0;

  const feeValidation = validatePaymentAgainstFee(paymentAmount, student.feeAmount);

  // Extract network fee
  const networkFee = parseFloat(tx.fee_paid || '0') / 10000000;

  // Record payment
  const paymentData = {
    schoolId,
    studentId: memo,
    txHash: tx.hash,
    transactionHash: tx.hash,
    correlationId,
    amount: paymentAmount,
    feeAmount: student.feeAmount,
    feeValidationStatus: cumulativeStatus,
    excessAmount,
    status: isSuspicious ? 'FAILED' : (isConfirmed ? 'SUCCESS' : 'PENDING'),
    memo,
    senderAddress,
    isSuspicious,
    suspicionReason,
    ledger: txLedger,
    ledgerSequence: txLedger,
    confirmationStatus,
    confirmationState: confirmation.state,
    confirmedAt: txDate,
    referenceCode: await generateReferenceCode(),
    networkFee,
    // #883 — snapshot fiat rate at confirmation (best-effort; null if feed unavailable)
    fiatSnapshot: isConfirmed && !isSuspicious
      ? await captureFiatSnapshot(paymentAmount, assetCode || 'XLM', process.env.DEFAULT_FIAT_CURRENCY || 'USD')
      : null,
  };

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await Payment.create([paymentData], { session });

      // Atomically update student balance if confirmed and not suspicious
      if (isConfirmed && !isSuspicious) {
        await Student.findOneAndUpdate(
          { schoolId, studentId: memo },
          {
            totalPaid: cumulativeTotal,
            remainingBalance: Math.max(0, remaining),
            feePaid: cumulativeTotal >= student.feeAmount,
          },
          { session }
        );
      }
    });

    sseEmit(schoolId, 'payment', {
      txHash: tx.hash,
      correlationId,
      studentId: memo,
      amount: paymentAmount,
      feeValidationStatus: cumulativeStatus,
      status: paymentData.status,
      confirmedAt: txDate,
    });

    logger.info('Transaction auto-detected and recorded', {
      txHash: tx.hash,
      correlationId,
      schoolId,
      studentId: memo,
      amount: paymentAmount,
      feeValidationStatus: cumulativeStatus,
      isSuspicious,
      confirmationStatus,
    });

    return { processed: true, payment: paymentData };
  } catch (error) {
    if (error.code === 11000) {
      return { processed: false, reason: 'duplicate' };
    }
    logger.error('Failed to record payment', { error: error.message, txHash: tx.hash, correlationId });
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Poll transactions for a single school.
 *
 * Wrapped in a per-school distributed lock (Redis SET NX PX) so that, across
 * horizontally-scaled replicas or an overlapping slow poll, only one worker
 * syncs a given school at a time. If the lock is already held the cycle is
 * skipped — the holder will pick up any new transactions. Correctness against
 * duplicate writes does not depend on the lock: the unique index on Payment
 * remains the authoritative dedup guard if the lock ever expires mid-poll.
 */
async function pollSchoolTransactions(school) {
  const lockKey = `sync:lock:${school.schoolId}`;
  const token = await lock.acquire(lockKey, SYNC_LOCK_TTL_MS);
  if (!token) {
    logger.debug('Skipping school poll — sync lock held by another worker', {
      schoolId: school.schoolId,
    });
    return { schoolId: school.schoolId, processed: 0, skipped: 0, lockSkipped: true };
  }

  try {
    const transactions = await server
      .transactions()
      .forAccount(school.stellarAddress)
      .order('desc')
      .limit(TRANSACTIONS_PER_POLL)
      .call();

    let processedCount = 0;
    let skippedCount = 0;

    for (const tx of transactions.records) {
      const result = await processTransaction(tx, school);
      if (result.processed) {
        processedCount++;
      } else {
        skippedCount++;
      }
    }

    if (processedCount > 0) {
      logger.info('Polling completed for school', {
        schoolId: school.schoolId,
        processed: processedCount,
        skipped: skippedCount,
      });
    }

    return { schoolId: school.schoolId, processed: processedCount, skipped: skippedCount };
  } catch (error) {
    logger.error('Error polling school transactions', {
      schoolId: school.schoolId,
      error: error.message,
    });
    return { schoolId: school.schoolId, error: error.message, horizonError: true };
  } finally {
    await lock.release(lockKey, token);
  }
}

/**
 * Poll all active schools for new transactions.
 * Applies exponential backoff when Horizon returns errors; resets to the
 * normal interval on the first fully-successful cycle.
 */
async function pollAllSchools() {
  if (!isPolling) return;

  try {
    const schools = await School.find({ isActive: true });
    
    if (schools.length === 0) {
      logger.debug('No active schools to poll');
      scheduleNextPoll();
      return;
    }

    logger.debug(`Polling ${schools.length} active schools`);

    const results = await Promise.allSettled(
      schools.map(school => pollSchoolTransactions(school))
    );

    const summary = results.reduce((acc, result) => {
      if (result.status === 'fulfilled') {
        acc.processed += result.value.processed || 0;
        acc.skipped += result.value.skipped || 0;
        if (result.value.horizonError) acc.errors++;
      } else {
        acc.errors++;
      }
      return acc;
    }, { processed: 0, skipped: 0, errors: 0 });

    if (summary.errors > 0) {
      // At least one school hit a Horizon error — back off.
      consecutiveErrors++;
      const backoff = Math.min(SYNC_INTERVAL_MS * Math.pow(2, consecutiveErrors), POLL_MAX_BACKOFF_MS);
      currentIntervalMs = backoff;
      logger.info('Horizon errors detected; backing off polling interval', {
        consecutiveErrors,
        nextIntervalMs: currentIntervalMs,
      });
    } else {
      // Successful cycle — reset backoff.
      if (consecutiveErrors > 0) {
        logger.info('Polling recovered; resetting interval to normal', {
          intervalMs: SYNC_INTERVAL_MS,
        });
      }
      consecutiveErrors = 0;
      currentIntervalMs = SYNC_INTERVAL_MS;
    }

    if (summary.processed > 0 || summary.errors > 0) {
      logger.info('Polling cycle completed', summary);
    }
  } catch (error) {
    consecutiveErrors++;
    const backoff = Math.min(SYNC_INTERVAL_MS * Math.pow(2, consecutiveErrors), POLL_MAX_BACKOFF_MS);
    currentIntervalMs = backoff;
    logger.error('Error in polling cycle', { error: error.message, nextIntervalMs: currentIntervalMs });
  }

  scheduleNextPoll();
}

/**
 * Schedule the next poll using the current (possibly backed-off) interval.
 * Uses setTimeout so the interval can change dynamically between cycles.
 */
function scheduleNextPoll() {
  if (!isPolling) return;
  pollingInterval = setTimeout(pollAllSchools, currentIntervalMs);
}

/**
 * Start the background polling service
 */
function startPolling() {
  if (isPolling) {
    logger.warn('Polling service already running');
    return;
  }

  // SYNC_INTERVAL_MS=0 disables auto-sync entirely (config contract).
  if (!SYNC_INTERVAL_MS || SYNC_INTERVAL_MS <= 0) {
    logger.info('Transaction polling disabled (SYNC_INTERVAL_MS=0)');
    return;
  }

  isPolling = true;
  consecutiveErrors = 0;
  currentIntervalMs = SYNC_INTERVAL_MS;
  logger.info('Starting transaction polling service', { intervalMs: SYNC_INTERVAL_MS });

  // Run immediately on startup, then self-schedule via setTimeout for backoff support
  pollAllSchools();
}

/**
 * Stop the background polling service
 */
function stopPolling() {
  if (!isPolling) return;

  isPolling = false;
  if (pollingInterval) {
    clearTimeout(pollingInterval);
    pollingInterval = null;
  }
  logger.info('Transaction polling service stopped');
}

module.exports = {
  startPolling,
  stopPolling,
  pollAllSchools,
  pollSchoolTransactions,
  processTransaction,
  // Exposed for testing
  _getBackoffState: () => ({ consecutiveErrors, currentIntervalMs }),
  _resetBackoffState: () => {
    consecutiveErrors = 0;
    currentIntervalMs = SYNC_INTERVAL_MS;
    isPolling = true; // allow direct pollAllSchools() calls in tests
    if (pollingInterval) { clearTimeout(pollingInterval); pollingInterval = null; }
  },
};
