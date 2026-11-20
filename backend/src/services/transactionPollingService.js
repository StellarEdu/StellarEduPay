'use strict';

const mongoose = require('mongoose');
const School = require('../models/schoolModel');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const { server } = require('../config/stellarConfig');
const { extractValidPayment, detectMemoCollision, detectCrossSchoolMemoCollision, detectAbnormalPatterns, determineConfirmationState } = require('./stellarService');
const { CONFIRMATION_STATES, isConfirmedOrAbove } = require('./paymentConfirmationStateMachine');
const { validatePaymentAmount } = require('../utils/paymentLimits');
const { compareAmounts, toStroops, stroopsToNumber, normalizeToNumber } = require('../utils/stellarAmount');
const { classifyFeePayment } = require('../utils/money');
const { generateReferenceCode } = require('../utils/generateReferenceCode');
const { emit: sseEmit } = require('./sseService');
const lock = require('./distributedLock');
const config = require('../config');
const logger = require('../utils/logger').child('TransactionPollingService');
const { deriveCorrelationId } = require('../utils/correlationId');
const { captureFiatSnapshot } = require('./currencyConversionService');
const { HorizonPollBudget, orderSchoolsByPriority } = require('./horizonPollBudget');
const { updateStudentBalance } = require('../utils/studentBalanceUpdater');
const { drainingWalletEntries } = require('./walletRotationService');
const { recordUnmatchedPayment } = require('./unmatchedPaymentService');
const { isBeforeIngestStart } = require('../utils/ingestWindow');
const {
  extractCreditableOperations,
  resolveCreditedAmount,
  resolveFeeCurrency,
} = require('./paymentIngestion');
const { recordPaymentVerificationAttempt } = require('./paymentVerificationAttemptService');

// Metrics — imported lazily inside helpers to survive jest module resets.
function _incFunnel(stage, schoolId) {
  try {
    require('../metrics').paymentFunnelTotal.inc({ stage, school_id: schoolId });
  } catch (_) {
    // metrics module unavailable — proceed without instrumentation
  }
}

let pollingInterval = null;
let isPolling = false;

// Base poll interval, honoring SYNC_INTERVAL_MS from config (which itself falls
// back to POLL_INTERVAL_MS). A value of 0 disables auto-sync entirely.
const SYNC_INTERVAL_MS = config.SYNC_INTERVAL_MS;
// TTL of the per-school distributed sync lock (crash-safety net).
const SYNC_LOCK_TTL_MS = config.SYNC_LOCK_TTL_MS;
// Safety cap on how many pages a single poll cycle will drain for one school.
// Bounds per-cycle work while letting a fresh school's history backfill across
// cycles (default: up to 50 pages × batchSize tx/cycle). Configurable.
const MAX_PAGES_PER_POLL = parseInt(process.env.SYNC_MAX_PAGES_PER_POLL || '50', 10);
// Adaptive batch sizing (#972): the per-page Horizon fetch size scales down as
// the processing queue fills, between MIN and MAX, starting from BASE.
const BASE_TRANSACTIONS_PER_POLL = 20;
const MIN_TRANSACTIONS_PER_POLL = 5;
const MAX_TRANSACTIONS_PER_POLL = 50;

// Exponential backoff state — reset on first successful poll after errors.
// POLL_MAX_BACKOFF_MS defaults to 5 minutes; configurable via env var.
const POLL_MAX_BACKOFF_MS = parseInt(process.env.POLL_MAX_BACKOFF_MS || '300000', 10);
let consecutiveErrors = 0;
let currentIntervalMs = SYNC_INTERVAL_MS;
// Timestamp (ms) of the first poll failure in the current outage; null while
// Horizon is reachable. Backs the health check's horizonUnreachableSince
// field and the horizon_unreachable_since_seconds gauge (#1340).
let horizonUnreachableSince = null;

function _markPollFailure() {
  if (horizonUnreachableSince === null) horizonUnreachableSince = Date.now();
  try {
    require('../metrics').horizonUnreachableSince.set(horizonUnreachableSince / 1000);
  } catch (_) { /* metrics module unavailable */ }
}

function _markPollSuccess() {
  horizonUnreachableSince = null;
  try {
    require('../metrics').horizonUnreachableSince.set(0);
  } catch (_) { /* metrics module unavailable */ }
}

// Coordinated cross-school Horizon request budget (#1124). Schools no longer
// poll as independent operations that each assume the whole rate limit is
// theirs; they draw page fetches from this single shared per-cycle allowance,
// spent in priority order. See services/horizonPollBudget.js for the rationale
// and docs/horizon-rate-limits.md for the SLA this underpins.
let pollBudget = new HorizonPollBudget({ intervalMs: SYNC_INTERVAL_MS });

// How many schools may be in flight at once. Bounded so a large tenant count
// can't open an unbounded number of simultaneous Horizon connections — the
// budget caps total requests, this caps their burstiness.
const MAX_CONCURRENT_SCHOOL_POLLS = Math.max(1, parseInt(
  process.env.SYNC_MAX_CONCURRENT_SCHOOLS || '4', 10));

/**
 * Process a single transaction for a school.
 *
 * #1973 — a transaction may credit several operations in different assets. We
 * record ONE Payment per creditable operation (keyed by { schoolId, txHash,
 * opIndex }), each with its own assetCode and amount, exactly like verify and
 * sync. Amounts of different assets are never summed.
 *
 * #1975/#1976 — every outcome is terminal or transient. Terminal outcomes
 * (recorded, duplicate, permanently rejected, unmatched-recorded) let the
 * caller advance the cursor past the transaction; transient outcomes
 * (`transient: true`) must stop cursor advancement so the tx is retried.
 */
async function processTransaction(tx, school, fencingToken) {
  const { schoolId, stellarAddress } = school;
  const correlationId = deriveCorrelationId(tx.hash);

  // Cheap optimisation only: skip work for transactions we've clearly already
  // recorded. This is NOT the dedup guarantee — it is a read-then-write race
  // (two workers can both miss the row). The authoritative guard is the unique
  // index on Payment { schoolId, txHash, opIndex }, which makes the insert
  // below fail atomically with code 11000 if a concurrent worker won the race.
  const existing = await Payment.findOne({ schoolId, txHash: tx.hash, deletedAt: null });
  if (existing) {
    return { processed: false, reason: 'duplicate', terminal: true };
  }

  // Funnel: transaction received by the poller
  _incFunnel('received', schoolId);

  // Extract and validate payment. One Horizon operations fetch per tx (#1976).
  const valid = await extractValidPayment(tx, stellarAddress);
  if (!valid) {
    return { processed: false, reason: 'invalid_payment', terminal: true };
  }

  const { memo, memoType } = valid;
  // #1973 — every creditable operation, each with its own asset and amount.
  const creditableOps = extractCreditableOperations(valid);
  if (creditableOps.length === 0) {
    return { processed: false, reason: 'invalid_payment', terminal: true };
  }

  // Validate each operation's amount against limits using its own asset.
  for (const op of creditableOps) {
    const limitValidation = await validatePaymentAmount(op.amount, {
      schoolId,
      asset: op.assetCode,
    });
    if (!limitValidation.valid) {
      logger.warn('Payment outside limits', {
        txHash: tx.hash,
        correlationId,
        schoolId,
        opIndex: op.opIndex,
        assetCode: op.assetCode,
        amount: op.amount,
        error: limitValidation.error,
      });
      // #1975 — record the terminal rejection so the tx is not re-fetched forever.
      await recordPaymentVerificationAttempt({
        schoolId,
        txHash: tx.hash,
        opIndex: op.opIndex,
        studentId: memo,
        assetCode: op.assetCode,
        amount: op.amount,
        outcome: 'rejected',
        reason: 'amount_limit_exceeded',
        detail: limitValidation.error || null,
      });
      return { processed: false, reason: 'amount_limit_exceeded', terminal: true };
    }
  }

  // Funnel: payment passed amount/memo validation
  _incFunnel('validated', schoolId);

  // Find student by memo (studentId)
  const student = await Student.findOne({ schoolId, studentId: memo });
  if (!student) {
    logger.warn('Student not found for memo', { txHash: tx.hash, correlationId, schoolId, memo });
    // Issue #1798 — keep the funds visible for review instead of only logging them.
    for (const op of creditableOps) {
      await recordUnmatchedPayment({
        schoolId,
        tx,
        payOp: op.payOp,
        memo,
        memoType,
        asset: op.asset,
        reason: 'student_not_found',
      });
    }
    return { processed: false, reason: 'student_not_found', terminal: true };
  }

  // Funnel: student matched by memo
  _incFunnel('matched', schoolId);

  // Check fencing token - reject if stale (another worker has newer lock)
  const currentFence = await lock.getCurrentFence(`sync:lock:${schoolId}`);
  if (currentFence !== null && currentFence !== fencingToken) {
    logger.warn('Stale fencing token - another worker acquired lock', {
      schoolId,
      expectedFence: fencingToken,
      currentFence,
      txHash: tx.hash,
    });
    // Transient: the tx must be retried by the worker that holds the lock.
    return { processed: false, reason: 'stale_lock', transient: true };
  }

  const txDate = new Date(tx.created_at);
  const txLedger = tx.ledger_attr || tx.ledger || null;
  const feeCurrency = resolveFeeCurrency(school, student);

  const confirmation = await determineConfirmationState(
    txLedger,
    CONFIRMATION_STATES.DETECTED,
    false,
  );
  const isConfirmed = isConfirmedOrAbove(confirmation.state);
  const confirmationStatus = confirmation.confirmationStatus;

  // Extract network fee
  const networkFee = parseFloat(tx.fee_paid || '0') / 10000000;

  const session = await mongoose.connection.startSession();
  try {
    const recorded = [];
    let balanceLockContended = false;

    await session.withTransaction(async () => {
      for (const op of creditableOps) {
        const senderAddress = op.payOp.from || null;
        const paymentAmount = op.amount;

        // Check for suspicious activity per operation.
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

        // #883 — snapshot fiat rate at confirmation (best-effort; null if feed unavailable)
        const fiatSnapshot = isConfirmed && !isSuspicious
          ? await captureFiatSnapshot(paymentAmount, op.assetCode || 'XLM', process.env.DEFAULT_FIAT_CURRENCY || 'USD')
          : null;

        // #1974 — credit in the fee currency using the recorded rate snapshot.
        const credited = resolveCreditedAmount({
          amount: paymentAmount,
          assetCode: op.assetCode,
          feeCurrency,
          fiatSnapshot,
        });
        if (credited.rejected) {
          logger.warn('Payment rejected: cannot credit in fee currency', {
            txHash: tx.hash,
            correlationId,
            schoolId,
            opIndex: op.opIndex,
            assetCode: op.assetCode,
            feeCurrency,
            reason: credited.reason,
          });
          await recordPaymentVerificationAttempt({
            schoolId,
            txHash: tx.hash,
            opIndex: op.opIndex,
            studentId: memo,
            assetCode: op.assetCode,
            amount: paymentAmount,
            outcome: 'rejected',
            reason: credited.reason,
          });
          continue;
        }

        // Calculate per-payment cumulative totals — used only for the payment
        // record's feeValidationStatus / excessAmount UI fields. Student balance
        // is NOT written here; that is exclusively updateStudentBalance's job.
        const previousPayments = await Payment.aggregate([
          { $match: { schoolId, studentId: memo, status: 'SUCCESS', isSuspicious: false, deletedAt: null } },
          { $group: { _id: null, total: { $sum: '$creditedAmount' } } },
        ]).session(session);
        const previousTotal = previousPayments.length ? previousPayments[0].total : 0;
        // Sum/diff in exact stroop space (#842) so an exact cumulative match is
        // never mis-flagged as underpaid/overpaid by a float rounding epsilon.
        const cumulativeTotal = stroopsToNumber(toStroops(previousTotal) + toStroops(credited.creditedAmount));

        // Route classification through the single canonical helper (#1766).
        const classification = classifyFeePayment({
          cumulativeTotal,
          feeAmount: student.feeAmount,
          installmentAmount: student.expectedInstallmentAmount,
          hasPlan: Boolean(student.paymentPlanId),
        });
        const cumulativeStatus = classification.status;
        const excessAmount = classification.excessAmount;

        const paymentData = {
          schoolId,
          studentId: memo,
          txHash: tx.hash,
          transactionHash: tx.hash,
          opIndex: op.opIndex,
          correlationId,
          amount: paymentAmount,
          assetCode: op.assetCode,
          feeCurrency,
          creditedAmount: credited.creditedAmount,
          creditedRate: credited.rate,
          feeAmount: student.feeAmount,
          feeValidationStatus: cumulativeStatus,
          excessAmount,
          status: isSuspicious ? 'FAILED' : (isConfirmed ? 'SUCCESS' : 'PENDING'),
          memo,
          senderAddress,
          isSuspicious,
          suspicionReason,
          receivedOnRetiredAddress: Boolean(school.receivedOnRetiredAddress),
          ledger: txLedger,
          ledgerSequence: txLedger,
          confirmationStatus,
          confirmationState: confirmation.state,
          confirmedAt: txDate,
          referenceCode: await generateReferenceCode(),
          networkFee,
          fiatSnapshot,
        };

        try {
          await Payment.create([paymentData], { session });
        } catch (error) {
          if (error.code === 11000) {
            // Another worker recorded this operation — terminal for this op.
            continue;
          }
          throw error;
        }

        // Fix #1751: Delegate all student balance writes to the single canonical
        // function (updateStudentBalance). Only update when the payment will
        // actually count in the canonical formula (SUCCESS, not suspicious).
        if (isConfirmed && !isSuspicious) {
          try {
            await updateStudentBalance(schoolId, memo, { session });
          } catch (err) {
            if (err.code === 'STUDENT_BALANCE_LOCK_CONTENDED') {
              // #1975 — transient: the balance lock is held elsewhere. The
              // payment row is written; the balance will be recomputed on the
              // next run, so we must NOT advance the cursor past this tx.
              balanceLockContended = true;
              logger.warn('Student balance lock contended during poll — will retry next cycle', {
                schoolId,
                studentId: memo,
                txHash: tx.hash,
                opIndex: op.opIndex,
              });
              continue;
            }
            throw err;
          }
        }

        recorded.push(paymentData);
      }
    });

    for (const paymentData of recorded) {
      sseEmit(schoolId, 'payment', {
        txHash: tx.hash,
        correlationId,
        studentId: memo,
        opIndex: paymentData.opIndex,
        amount: paymentData.amount,
        assetCode: paymentData.assetCode,
        creditedAmount: paymentData.creditedAmount,
        feeCurrency: paymentData.feeCurrency,
        feeValidationStatus: paymentData.feeValidationStatus,
        status: paymentData.status,
        confirmedAt: txDate,
      }, correlationId);
    }

    if (recorded.length > 0) {
      logger.info('Transaction auto-detected and recorded', {
        txHash: tx.hash,
        correlationId,
        schoolId,
        studentId: memo,
        operations: recorded.length,
        amounts: recorded.map(p => ({ assetCode: p.assetCode, amount: p.amount, creditedAmount: p.creditedAmount })),
        confirmationStatus,
      });
    }

    if (balanceLockContended) {
      return { processed: recorded.length > 0, payments: recorded, reason: 'balance_lock_contended', transient: true };
    }
    if (recorded.length === 0) {
      // Every operation was either a duplicate or rejected — terminal.
      return { processed: false, reason: 'no_creditable_operations', terminal: true };
    }
    return { processed: true, payments: recorded, terminal: true };
  } catch (error) {
    if (error.code === 11000) {
      return { processed: false, reason: 'duplicate', terminal: true };
    }
    logger.error('Failed to record payment', { error: error.message, txHash: tx.hash, correlationId });
    // Transient: DB/Horizon error — do not advance the cursor past this tx.
    return { processed: false, reason: 'transient_error', transient: true, error: error.message };
  } finally {
    await session.endSession();
  }
}

/**
 * Poll transactions for a single school.
 *
 * Cursor management (#839): the poller persists a per-school Horizon
 * `paging_token` cursor (`school.syncCursor`) and resumes ASCENDING paging from
 * it every cycle. This is the key to being both gap-free and efficient:
 *   - Ascending order from the saved cursor means we always move forward and
 *     never skip a transaction (no missed payments).
 *   - Persisting the cursor means we never replay history from genesis on each
 *     cycle (no unbounded re-scans / excess Horizon load). A fresh school with
 *     no cursor starts from the oldest transaction and backfills across cycles,
 *     bounded by MAX_PAGES_PER_POLL per cycle.
 * The cursor is advanced over EVERY examined transaction (processed or skipped)
 * and persisted after each page, so a crash mid-cycle resumes correctly without
 * gaps or rescans.
 *
 * Horizon 429 / errors: any Horizon failure (including HTTP 429 rate limiting)
 * throws out of the page fetch and is reported as `horizonError`, which drives
 * the cycle-level exponential backoff in pollAllSchools. Because the cursor is
 * only advanced for transactions we actually examined and persisted, a 429
 * mid-cycle never skips transactions — the next cycle resumes from the last
 * persisted token.
 *
 * Wrapped in a per-school distributed lock (Redis SET NX PX) so that, across
 * horizontally-scaled replicas or an overlapping slow poll, only one worker
 * syncs a given school at a time. If the lock is already held the cycle is
 * skipped — the holder will pick up any new transactions. Correctness against
 * duplicate writes does not depend on the lock: the unique index on Payment
 * remains the authoritative dedup guard if the lock ever expires mid-poll.
 */
/**
 * Read the payment-processor queue depth that drives polling backpressure.
 *
 * The concurrent payment processor was removed (#1036) and no replacement
 * currently emits queue depth, so this reports an empty queue. That is the
 * explicit no-throttle fallback — the same `const queueDepth = 0;` pattern
 * used in healthController.js — rather than a guarded `require` of a module
 * that no longer exists. See docs/architecture.md for what now provides
 * backpressure on payment processing.
 */
function getQueueBackpressureState() {
  const queueDepth = 0;
  const maxQueueDepth = config.MAX_QUEUE_DEPTH;
  const highWater = Math.min(config.QUEUE_BACKPRESSURE_HIGH_WATER, maxQueueDepth);
  const lowWater = Math.min(config.QUEUE_BACKPRESSURE_LOW_WATER, Math.max(0, highWater - 1));
  return { queueDepth, maxQueueDepth, highWater, lowWater };
}

function getEffectiveBatchSize(queueDepth) {
  const { highWater, lowWater } = getQueueBackpressureState();
  if (queueDepth >= highWater) return 0;
  if (queueDepth <= lowWater) return BASE_TRANSACTIONS_PER_POLL;

  const pressureRatio = (queueDepth - lowWater) / Math.max(1, highWater - lowWater);
  const scaled = Math.round(BASE_TRANSACTIONS_PER_POLL * (1 - pressureRatio));
  return Math.max(MIN_TRANSACTIONS_PER_POLL, Math.min(MAX_TRANSACTIONS_PER_POLL, scaled));
}

/**
 * Poll one school's wallet. With `retired` set ({ address, cursor }), poll that
 * retired address instead, using its own cursor (#1799).
 */
async function pollSchoolTransactions(school, budget = null, retired = null) {
  const backpressure = getQueueBackpressureState();
  if (backpressure.queueDepth >= backpressure.highWater) {
    logger.warn('Skipping school poll due to high payment processor queue depth', {
      schoolId: school.schoolId,
      queueDepth: backpressure.queueDepth,
      highWater: backpressure.highWater,
    });
    return {
      schoolId: school.schoolId,
      processed: 0,
      skipped: 0,
      loadPaused: true,
      queueDepth: backpressure.queueDepth,
    };
  }

  const address = retired ? retired.address : school.stellarAddress;
  // A retired address is credited like the current one, but its payments are
  // flagged so the school can see them (#1799).
  const scope = retired
    ? { ...school, stellarAddress: address, receivedOnRetiredAddress: true }
    : school;

  const lockKey = `sync:lock:${school.schoolId}`;
  const acquired = await lock.acquire(lockKey, SYNC_LOCK_TTL_MS);
  if (!acquired) {
    logger.debug('Skipping school poll — sync lock held by another worker', {
      schoolId: school.schoolId,
    });
    return { schoolId: school.schoolId, processed: 0, skipped: 0, lockSkipped: true };
  }

  const { token, fencingToken } = acquired;
  const stopWatchdog = lock.startWatchdog
    ? lock.startWatchdog(lockKey, token, SYNC_LOCK_TTL_MS)
    : null;

  let cursor = retired ? retired.cursor || null : school.syncCursor || null;
  const startCursor = cursor;
  let processedCount = 0;
  let skippedCount = 0;
  let budgetExhausted = false;

  try {
    // Adaptive batch size based on queue backpressure (#972). The early
    // load-pause guard above already bails when the queue is saturated, so
    // here batchSize is always >= MIN_TRANSACTIONS_PER_POLL.
    const batchSize = getEffectiveBatchSize(backpressure.queueDepth);
    if (batchSize !== BASE_TRANSACTIONS_PER_POLL) {
      logger.debug('Adjusted poll batch size based on queue depth', {
        schoolId: school.schoolId,
        queueDepth: backpressure.queueDepth,
        batchSize,
      });
    }

    for (let pages = 0; pages < MAX_PAGES_PER_POLL; pages++) {
      // Draw from the shared cross-school budget before every page fetch
      // (#1124). Running out is a normal, ordered outcome: we stop here, the
      // cursor is already persisted, and the remaining pages resume next cycle
      // with this school's priority raised by aging. That is strictly better
      // than issuing the request and being 429'd, which costs the same quota
      // and returns nothing.
      if (budget && !budget.tryConsume(1)) {
        budgetExhausted = true;
        logger.debug('Poll budget exhausted mid-school — deferring remaining pages', {
          schoolId: school.schoolId,
          pagesFetched: pages,
          processed: processedCount,
        });
        break;
      }

      let builder = server
        .transactions()
        .forAccount(address)
        .order('asc')
        .limit(batchSize);
      // Resume from the persisted cursor; omit on first-ever run so Horizon
      // returns from the oldest transaction.
      if (cursor) builder = builder.cursor(cursor);

      const page = await builder.call();
      const records = (page && page.records) || [];
      if (records.length === 0) break;

      let stopAdvancing = false;
      for (const tx of records) {
        if (isBeforeIngestStart(tx, school)) {
          skippedCount++;
          if (tx.paging_token) cursor = tx.paging_token;
          continue;
        }
        const result = await processTransaction(tx, scope, fencingToken);
        if (result.processed) {
          processedCount++;
          if (retired) {
            logger.warn('Payment credited to a retired wallet address', {
              schoolId: school.schoolId,
              address,
              txHash: tx.hash,
            });
          }
        } else {
          skippedCount++;
        }
        // #1975/#1976 — only advance the cursor past a TERMINAL outcome. A
        // transient outcome (balance lock contention, DB/Horizon error) must
        // stop advancement so the tx is retried on the next cycle.
        if (result.transient) {
          stopAdvancing = true;
          logger.info('Stopping cursor advancement at transient outcome', {
            schoolId: school.schoolId,
            txHash: tx.hash,
            reason: result.reason,
          });
          break;
        }
        // Advance past every terminally-examined tx — we never need to re-read
        // it. Reorg / confirmation promotion is handled separately by
        // finalizeConfirmedPayments.
        if (tx.paging_token) cursor = tx.paging_token;
      }

      // Persist the cursor after each page so a crash resumes without gaps/rescans.
      if (cursor && cursor !== startCursor) {
        if (retired) {
          await School.updateOne(
            { schoolId: school.schoolId, 'walletHistory.address': address },
            { $set: { 'walletHistory.$.cursor': cursor } },
          );
        } else {
          await School.updateOne(
            { schoolId: school.schoolId },
            { $set: { syncCursor: cursor } },
          );
        }
      }

      if (stopAdvancing) {
        // Transient outcome — stop this cycle; the persisted cursor points at
        // the last terminal tx so the next cycle resumes here.
        break;
      }

      if (records.length < batchSize) {
        // Drained — this school needs no more of the budget this cycle. The
        // token for the page we're inside was already spent, so nothing to
        // refund; we simply stop competing for the rest.
        break;
      }
    }

    if (processedCount > 0) {
      logger.info('Polling completed for school', {
        schoolId: school.schoolId,
        processed: processedCount,
        skipped: skippedCount,
        cursor,
      });
    }

    return {
      schoolId: school.schoolId,
      processed: processedCount,
      skipped: skippedCount,
      cursor,
      budgetExhausted,
    };
  } catch (error) {
    const status = error.response?.status || error.status || error.statusCode;
    const rateLimited = status === 429;
    // Feed observed 429s back into the budget so the next cycle's ceiling
    // reflects Horizon's real limit rather than the configured guess (#1124).
    if (rateLimited && budget) budget.recordRateLimited();
    logger.error('Error polling school transactions', {
      schoolId: school.schoolId,
      error: error.message,
      status,
      rateLimited,
    });
    return {
      schoolId: school.schoolId,
      error: error.message,
      horizonError: true,
      status,
      rateLimited,
    };
  } finally {
    if (stopWatchdog) stopWatchdog();
    await lock.release(lockKey, token);
  }
}

/**
 * Poll a school's current wallet, then each retired wallet still inside its
 * drain window, one after another (#1799). A failure on a retired address is
 * logged and does not stop the current address's result.
 */
async function pollSchoolWithDrainingAddresses(school, budget = null) {
  const result = await pollSchoolTransactions(school, budget);
  for (const retired of drainingWalletEntries(school)) {
    try {
      await pollSchoolTransactions(school, budget, retired);
    } catch (err) {
      logger.error('Error draining retired wallet address', {
        schoolId: school.schoolId,
        address: retired.address,
        error: err.message,
      });
    }
  }
  return result;
}

/**
 * Gather the per-school signals that drive priority ordering (#1124).
 *
 * Deliberately ONE aggregate query for all schools rather than a query per
 * school: this runs every cycle, and a per-tenant query would reintroduce the
 * very linear-scaling problem we're fixing — just against MongoDB instead of
 * Horizon.
 *
 * Signals are best-effort. If the query fails, every school scores 0 from this
 * source and ordering falls back to aging alone, which is still correct — just
 * less well-informed. Polling must never stop because prioritisation couldn't
 * be computed.
 *
 * @param {Array<object>} schools
 * @param {HorizonPollBudget} budget
 * @returns {Promise<Map<string, object>>} schoolId → signals
 */
async function gatherSchoolSignals(schools, budget) {
  const signals = new Map();

  // Aging applies regardless of whether the DB lookup succeeds.
  for (const school of schools) {
    signals.set(school.schoolId, {
      pendingCount: 0,
      lastActivityAt: null,
      cyclesDeferred: budget.getDeferralCount(school.schoolId),
    });
  }

  try {
    const schoolIds = schools.map(s => s.schoolId);
    const rows = await Payment.aggregate([
      { $match: { schoolId: { $in: schoolIds }, deletedAt: null } },
      {
        $group: {
          _id: '$schoolId',
          // Payments seen on-chain but not yet fully confirmed — the parents
          // behind these are the ones actively waiting.
          pendingCount: {
            $sum: {
              $cond: [{ $ne: ['$confirmationStatus', 'confirmed'] }, 1, 0],
            },
          },
          lastActivityAt: { $max: '$confirmedAt' },
        },
      },
    ]);

    for (const row of rows) {
      const existing = signals.get(row._id);
      if (existing) {
        existing.pendingCount = row.pendingCount || 0;
        existing.lastActivityAt = row.lastActivityAt || null;
      }
    }
  } catch (error) {
    logger.warn('Could not gather school priority signals — falling back to aging only', {
      error: error.message,
    });
  }

  return signals;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results and never rejecting — each entry mirrors the
 * Promise.allSettled shape the caller already expects.
 *
 * Replaces the previous unbounded `Promise.allSettled(schools.map(...))`, which
 * opened one Horizon conversation per school simultaneously (#1124).
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runner() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner()),
  );

  return results;
}

function _recordBudgetMetrics(stats) {
  try {
    const metrics = require('../metrics');
    metrics.horizonPollBudgetRemaining.set(stats.remaining);
    metrics.horizonPollBudgetCeiling.set(stats.currentCeiling);
    metrics.horizonPollDeferredSchools.set(stats.deferredSchools);
    metrics.horizonPollMaxDeferralCycles.set(stats.maxDeferralCycles);
    if (stats.consumedThisCycle > 0) {
      metrics.horizonPollRequestsTotal.inc(stats.consumedThisCycle);
    }
    if (stats.rateLimitEventsThisCycle > 0) {
      metrics.horizonRateLimitedTotal.inc(stats.rateLimitEventsThisCycle);
    }
  } catch (_) {
    // metrics module unavailable — polling proceeds without instrumentation
  }
}

/**
 * Poll all active schools for new transactions.
 * Applies exponential backoff when Horizon returns errors; resets to the
 * normal interval on the first fully-successful cycle.
 */
async function pollAllSchools() {
  if (!isPolling) return;

  const cycleId = require('../utils/correlationId').generateId();
  const cycleStartTime = Date.now();

  try {
    const schools = await School.find({ isActive: true });

    if (schools.length === 0) {
      logger.debug('No active schools to poll');
      scheduleNextPoll();
      return;
    }

    logger.debug(`Polling ${schools.length} active schools`);

    // ── Coordinated budgeting (#1124) ──────────────────────────────────────
    // Open the cycle's shared allowance, then decide the ORDER in which to
    // spend it. Ordering is what keeps user-visible delay low when the budget
    // binds: a school with payments awaiting confirmation is polled before a
    // settled school whose poll would return nothing.
    const budgetForCycle = pollBudget.startCycle();
    const signals = await gatherSchoolSignals(schools, pollBudget);
    const ordered = orderSchoolsByPriority(schools, signals);

    logger.debug('Poll cycle budget opened', {
      schools: schools.length,
      budget: budgetForCycle,
      topPriority: ordered[0] ? ordered[0].school.schoolId : null,
    });

    const results = await runWithConcurrency(
      ordered,
      MAX_CONCURRENT_SCHOOL_POLLS,
      ({ school }) => pollSchoolWithDrainingAddresses(school, pollBudget),
    );

    const summary = results.reduce((acc, result) => {
      if (result.status === 'fulfilled') {
        acc.processed += result.value.processed || 0;
        acc.skipped += result.value.skipped || 0;
        if (result.value.horizonError) acc.errors++;
        if (result.value.rateLimited) acc.rateLimited++;
        if (result.value.budgetExhausted) acc.budgetDeferred++;
      } else {
        acc.errors++;
      }
      return acc;
    }, { processed: 0, skipped: 0, errors: 0, rateLimited: 0, budgetDeferred: 0 });

    // Update aging counters: a school that got no budget at all this cycle
    // gains priority for the next one, which is what bounds worst-case
    // staleness for quiet tenants.
    for (let i = 0; i < ordered.length; i++) {
      const { school } = ordered[i];
      const result = results[i];
      const polled = result.status === 'fulfilled' &&
        !result.value.budgetExhausted &&
        !result.value.lockSkipped &&
        !result.value.loadPaused;
      if (polled) {
        pollBudget.recordPolled(school.schoolId);
      } else {
        pollBudget.recordDeferred(school.schoolId);
      }
    }

    _recordBudgetMetrics(pollBudget.getStats());

    if (summary.budgetDeferred > 0) {
      logger.info('Poll budget bound this cycle — some schools deferred', {
        ...pollBudget.getStats(),
        deferredThisCycle: summary.budgetDeferred,
      });
    }

    if (summary.errors > 0) {
      // At least one school hit a Horizon error — back off.
      consecutiveErrors++;
      _markPollFailure();
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
      _markPollSuccess();
    }

    const cycleDurationMs = Date.now() - cycleStartTime;
    const budgetStats = pollBudget.getStats();

    logger.info('Polling cycle summary', {
      cycleId,
      schoolsPolled: schools.length,
      transactionsProcessed: summary.processed,
      transactionsSkipped: summary.skipped,
      newPayments: summary.processed,
      durationMs: cycleDurationMs,
      budgetPagesUsed: budgetStats.consumedThisCycle || 0,
      errors: summary.errors,
      rateLimited: summary.rateLimited,
    });

    // Emit polling cycle duration metric
    try {
      require('../metrics').pollingCycleDurationSeconds.observe(cycleDurationMs / 1000);
    } catch (_) {
      // metrics module unavailable
    }

    if (summary.processed > 0 || summary.errors > 0) {
      logger.info('Polling cycle completed', summary);
    }
  } catch (error) {
    const cycleDurationMs = Date.now() - cycleStartTime;
    consecutiveErrors++;
    _markPollFailure();
    const backoff = Math.min(SYNC_INTERVAL_MS * Math.pow(2, consecutiveErrors), POLL_MAX_BACKOFF_MS);
    currentIntervalMs = backoff;
    logger.error('Error in polling cycle', { cycleId, durationMs: cycleDurationMs, error: error.message, nextIntervalMs: currentIntervalMs });
  }

  // Record heartbeat after every cycle (success or error) so the health check
  // can confirm the polling loop is still alive.
  try {
    const { ping, WORKER_NAMES } = require('./workerHeartbeat');
    ping(WORKER_NAMES.POLLING_SYNC);
  } catch (_) {
    // Non-critical — do not interrupt polling if heartbeat module is unavailable.
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
  horizonUnreachableSince = null;
  logger.info('Starting transaction polling service', { intervalMs: SYNC_INTERVAL_MS });

  try {
    const { markStarted, WORKER_NAMES } = require('./workerHeartbeat');
    markStarted(WORKER_NAMES.POLLING_SYNC);
  } catch (_) { /* non-critical */ }

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
  try {
    const { markStopped, WORKER_NAMES } = require('./workerHeartbeat');
    markStopped(WORKER_NAMES.POLLING_SYNC);
  } catch (_) { /* non-critical */ }
  logger.info('Transaction polling service stopped');
}

module.exports = {
  startPolling,
  stopPolling,
  pollAllSchools,
  pollSchoolTransactions,
  pollSchoolWithDrainingAddresses,
  processTransaction,
  isBeforeIngestStart,
  // Exposed for testing
  _getBackoffState: () => ({ consecutiveErrors, currentIntervalMs }),
  getHorizonUnreachableSince: () => horizonUnreachableSince,
  _getBudgetStats: () => pollBudget.getStats(),
  _setPollBudget: (budget) => { pollBudget = budget; },
  _runWithConcurrency: runWithConcurrency,
  _gatherSchoolSignals: gatherSchoolSignals,
  _resetBackoffState: () => {
    consecutiveErrors = 0;
    currentIntervalMs = SYNC_INTERVAL_MS;
    horizonUnreachableSince = null;
    pollBudget = new HorizonPollBudget({ intervalMs: SYNC_INTERVAL_MS });
    isPolling = true; // allow direct pollAllSchools() calls in tests
    if (pollingInterval) { clearTimeout(pollingInterval); pollingInterval = null; }
  },
};
