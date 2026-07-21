"use strict";

const { Operation } = require("@stellar/stellar-sdk");
const {
  server,
  isAcceptedAsset,
  CONFIRMATION_THRESHOLD,
  FINALIZATION_THRESHOLD,
} = require("../config/stellarConfig");
const mongoose = require("mongoose");
const Payment = require("../models/paymentModel");
const Student = require("../models/studentModel");
const PaymentIntent = require("../models/paymentIntentModel");
const { validatePaymentAmount } = require("../utils/paymentLimits");
const { toStroops, stroopsToNumber, compareAmounts } = require("../utils/stellarAmount");
const {
  SUPPORTED_MEMO_TYPES,
  normalizeMemoType,
  decodeMemoToCanonical,
} = require("../utils/stellarMemo");
const { withStellarRetry } = require("../utils/withStellarRetry");
const { savePayment } = require("./transactionService");
const { deriveCorrelationId } = require("../utils/correlationId");
const {
  CONFIRMATION_STATES,
  computeTargetState,
  resolveNextState,
  deriveLegacyConfirmationStatus,
  isConfirmedOrAbove,
} = require("./paymentConfirmationStateMachine");
const logger = require("../utils/logger").child("StellarService");

function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === "native" ? "XLM" : payOp.asset_code;
  const assetIssuer = assetType === "native" ? null : payOp.asset_issuer;
  // Pass the issuer so credit assets (USDC) are validated against the pinned
  // canonical issuer for the active network (#841). A fake "USDC" from any
  // other issuer is rejected here.
  const { accepted } = isAcceptedAsset(assetCode, assetType, assetIssuer);
  if (!accepted) return null;
  return { assetCode, assetType, assetIssuer };
}

/**
 * Normalize a Horizon API amount string to a JS number using the Stellar SDK
 * as the canonical source of truth for 7-decimal-place precision.
 *
 * Horizon returns amounts as decimal strings (e.g. '100.0000000'). Both XLM
 * and USDC use 7 decimal places on Stellar, so the same conversion applies to
 * all accepted assets. We round-trip through stroops via Operation._fromXDRAmount
 * to guarantee the SDK's precision rules are applied consistently.
 *
 * @param {string} rawAmount - Decimal amount string from Horizon API
 * @returns {number}
 */
function normalizeAmount(rawAmount) {
  // Convert Horizon decimal string → stroop integer → SDK-normalized decimal
  const stroops = String(Math.round(parseFloat(rawAmount) * 1e7));
  return parseFloat(Operation._fromXDRAmount(stroops));
}

/**
 * Extract and validate the payment operation from a transaction.
 * Handles fee-bump transactions by unwrapping to the inner transaction.
 * walletAddress is passed explicitly — supports per-school wallets.
 * Returns { payOp, memo, asset, memoType } or null if the transaction is invalid.
 * 
 * Memo type handling:
 *   - MEMO_TEXT: Valid for student ID matching
 *   - MEMO_NONE: No memo provided (MISSING_MEMO)
 *   - MEMO_ID, MEMO_HASH, MEMO_RETURN: Unsupported types (UNSUPPORTED_MEMO_TYPE)
 */
async function extractValidPayment(tx, walletAddress) {
  // #840 — A transaction can be included in a ledger yet have
  // `successful === false` (e.g. a failed operation). Such transactions must
  // NEVER be credited. Require an explicit success flag rather than merely
  // truthy, so a failed-but-included tx (or one missing the flag) is rejected.
  if (tx.successful !== true) return null;

  // Unwrap fee-bump transaction to get the inner transaction
  const innerTx = tx.inner_transaction || tx;

  // Check memo type and handle accordingly
  const memoType = innerTx.memo_type || 'none';
  
  if (memoType === 'none') {
    // No memo provided
    return null;
  }
  
  if (!normalizeMemoType(memoType)) {
    // MEMO_RETURN — no canonical encoding, so it cannot identify a payment.
    logger.warn('Transaction has unsupported memo type', {
      txHash: tx.hash,
      memoType,
      memo: innerTx.memo,
    });
    return null;
  }

  // MEMO_ID / MEMO_HASH decode back to the canonical intent memo (#1118).
  const memo = decodeMemoToCanonical(innerTx.memo, memoType);
  if (!memo) {
    logger.warn('Transaction memo could not be decoded to a payment reference', {
      txHash: tx.hash,
      memoType,
    });
    return null;
  }

  const ops = await withStellarRetry(() => innerTx.operations(), {
    label: "extractValidPayment.operations",
  });
  // #840 — only a successful `payment` operation landing on the school wallet
  // is creditable. detectAsset then enforces the asset/issuer (#841): a
  // wrong-asset or fake-issuer operation yields null and is rejected here.
  const payOp = ops.records.find(
    (op) => op.type === "payment" && op.to === walletAddress,
  );
  if (!payOp) return null;

  const asset = detectAsset(payOp);
  if (!asset) return null;

  return { payOp, memo, asset, memoType };
}

function validatePaymentAgainstFee(paymentAmount, expectedFee) {
  // Compare in exact integer stroop space (#842). Float comparison of the paid
  // amount vs the fee can mis-judge an exact-match payment as short/over by a
  // rounding epsilon; stroop comparison is exact.
  const paidStroops = toStroops(paymentAmount);
  const feeStroops = toStroops(expectedFee);

  if (paidStroops < feeStroops) {
    return {
      status: "underpaid",
      excessAmount: 0,
      message: `Payment of ${paymentAmount} is less than the required fee of ${expectedFee}`,
    };
  }
  if (paidStroops > feeStroops) {
    const excess = stroopsToNumber(paidStroops - feeStroops);
    return {
      status: "overpaid",
      excessAmount: excess,
      message: `Payment of ${paymentAmount} exceeds the required fee of ${expectedFee} by ${excess}`,
    };
  }
  return {
    status: "valid",
    excessAmount: 0,
    message: "Payment matches the required fee",
  };
}

async function getLatestLedgerSequence(label) {
  const latestLedger = await withStellarRetry(
    () => server.ledgers().order("desc").limit(1).call(),
    { label },
  );
  return latestLedger.records[0].sequence;
}

async function checkConfirmationStatus(txLedger) {
  const latestSequence = await getLatestLedgerSequence(
    "checkConfirmationStatus",
  );
  return latestSequence - txLedger >= CONFIRMATION_THRESHOLD;
}

/**
 * Determine the next confirmation state for a payment per the finality
 * policy (issue #747). Fetches the latest Horizon ledger sequence, computes
 * the state the ledger depth + suspicion flag implies, then resolves it
 * against the payment's current state via the idempotent/monotonic state
 * machine — re-running this with the same inputs (e.g. a re-poll of the same
 * ledger range) always yields the same result and never regresses a payment.
 *
 * @param {number|null} txLedger - ledger sequence the tx was included in
 * @param {string} [currentState] - payment's current confirmationState (defaults to 'detected')
 * @param {boolean} [isSuspicious] - fraud/anomaly signal
 * @returns {Promise<{ state: string, changed: boolean, confirmationStatus: string, latestLedgerSequence: number }>}
 */
async function determineConfirmationState(
  txLedger,
  currentState = CONFIRMATION_STATES.DETECTED,
  isSuspicious = false,
) {
  const latestLedgerSequence = await getLatestLedgerSequence(
    "determineConfirmationState",
  );
  const targetState = computeTargetState({
    txLedger,
    latestLedgerSequence,
    isSuspicious,
    confirmationThreshold: CONFIRMATION_THRESHOLD,
    finalizationThreshold: FINALIZATION_THRESHOLD,
  });
  const { state, changed } = resolveNextState(currentState, targetState);

  return {
    state,
    changed,
    confirmationStatus: deriveLegacyConfirmationStatus(state),
    latestLedgerSequence,
  };
}

/**
 * Detect memo collision: same memo used by a different sender within 24h,
 * or payment amount is wildly outside the expected fee range.
 * Query is school-scoped via schoolId.
 */
async function detectMemoCollision(
  memo,
  senderAddress,
  paymentAmount,
  expectedFee,
  txDate,
  schoolId,
) {
  const COLLISION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const windowStart = new Date(txDate.getTime() - COLLISION_WINDOW_MS);

  const recentFromOtherSender = await Payment.findOne({
    schoolId,
    memo,
    senderAddress: { $ne: senderAddress, $exists: true, $ne: null },
    confirmedAt: { $gte: windowStart },
    deletedAt: null,
  });

  if (recentFromOtherSender) {
    return {
      suspicious: true,
      reason:
        'Memo "' +
        memo +
        '" was used by a different sender (' +
        recentFromOtherSender.senderAddress +
        ") within the last 24 hours",
    };
  }

  return { suspicious: false, reason: null };
}

/**
 * Detect memo collision across schools: the same memo (student ID) was
 * recorded as a confirmed payment for a *different* school within the last
 * 24 hours. Memos are only unique within a school's own student roster
 * (`Student.studentId` is school-scoped), so two unrelated schools can
 * legitimately assign the same ID to different students — but a payment
 * landing under that ID at two schools in a short window is worth flagging
 * for manual review rather than silently trusting both.
 *
 * Deliberately independent of `detectMemoCollision` (which is single-school,
 * sender-based) — this is the cross-school signal the original function
 * explicitly does not cover.
 */
async function detectCrossSchoolMemoCollision(memo, schoolId, txDate) {
  const COLLISION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const windowStart = new Date(txDate.getTime() - COLLISION_WINDOW_MS);

  const recentFromOtherSchool = await Payment.findOne({
    schoolId: { $ne: schoolId },
    studentId: memo,
    confirmedAt: { $gte: windowStart },
    deletedAt: null,
  });

  if (recentFromOtherSchool) {
    return {
      suspicious: true,
      reason:
        'Memo "' +
        memo +
        '" was also used for a payment to a different school (' +
        recentFromOtherSchool.schoolId +
        ") within the last 24 hours",
    };
  }

  return { suspicious: false, reason: null };
}

/**
 * Compute the mean and (population) standard deviation of a school's confirmed,
 * non-suspicious payment amounts within a lookback window. Used to base the
 * suspicious-amount threshold on each tenant's OWN distribution rather than a
 * flat multiplier off the expected fee.
 *
 * @param {string} schoolId
 * @param {number} windowDays lookback window
 * @returns {Promise<{count:number, mean:number, std:number}>}
 */
async function computeHistoricalAmountStats(schoolId, windowDays) {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await Payment.aggregate([
    {
      $match: {
        schoolId,
        isSuspicious: false,
        deletedAt: null,
        confirmedAt: { $gte: windowStart },
        amount: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        mean: { $avg: "$amount" },
        std: { $stdDevPop: "$amount" },
      },
    },
  ]);

  if (!rows.length) return { count: 0, mean: 0, std: 0 };
  return {
    count: rows[0].count || 0,
    mean: rows[0].mean || 0,
    std: rows[0].std || 0,
  };
}

/**
 * Detect abnormal payment patterns:
 *  1. Rapid repeated transactions — same sender sends more than RAPID_TX_LIMIT
 *     payments within RAPID_TX_WINDOW_MS.
 *  2. Unusual amount — by default the payment deviates from the expected fee by
 *     more than the school's configured multiplier (default 3×). When the
 *     school opts into historical mode (`amountConfig.mode === 'historical'`)
 *     and enough history exists, the threshold is a z-score against the
 *     school's own confirmed-payment distribution instead.
 *
 * Returns { suspicious: boolean, reason: string|null }
 *
 * @param {object|null} amountConfig per-tenant suspiciousAmountConfig (optional)
 */
async function detectAbnormalPatterns(
  senderAddress,
  paymentAmount,
  expectedFee,
  txDate,
  schoolId,
  suspiciousPaymentMultiplier = 3.0,
  amountConfig = null,
) {
  const RAPID_TX_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const RAPID_TX_LIMIT = 3; // more than this many = suspicious

  const reasons = [];

  // 1. Velocity check — rapid repeated transactions from the same sender
  if (senderAddress) {
    const windowStart = new Date(txDate.getTime() - RAPID_TX_WINDOW_MS);
    const recentCount = await Payment.countDocuments({
      schoolId,
      senderAddress,
      confirmedAt: { $gte: windowStart },
      deletedAt: null,
    });
    if (recentCount >= RAPID_TX_LIMIT) {
      reasons.push(
        `Sender ${senderAddress} made ${recentCount + 1} transactions within 10 minutes`,
      );
    }
  }

  // 2. Unusual amount check.
  // 2a. Historical mode — flag amounts far from the school's own mean. Falls
  //     back to the fee-multiplier check below if there isn't enough history.
  let historicalApplied = false;
  if (amountConfig && amountConfig.mode === "historical" && schoolId) {
    const windowDays = amountConfig.historicalWindowDays || 90;
    const stdMultiplier = amountConfig.historicalStdDevMultiplier || 3.0;
    const minSamples = amountConfig.historicalMinSamples || 20;

    try {
      const stats = await computeHistoricalAmountStats(schoolId, windowDays);
      if (stats.count >= minSamples && stats.std > 0) {
        historicalApplied = true;
        const zScore = Math.abs(paymentAmount - stats.mean) / stats.std;
        if (zScore >= stdMultiplier) {
          reasons.push(
            `Unusual payment amount (z-score ${zScore.toFixed(2)} vs school mean ${stats.mean.toFixed(2)}, threshold ${stdMultiplier.toFixed(1)}σ over ${stats.count} payments)`,
          );
        }
      }
    } catch (err) {
      logger.warn("Historical suspicious-amount check failed; falling back to fee multiplier", {
        schoolId,
        error: err.message,
      });
    }
  }

  // 2b. Fee-multiplier mode (default, and the historical fallback).
  if (!historicalApplied && expectedFee && expectedFee > 0) {
    const ratio = paymentAmount / expectedFee;
    const lowerThreshold = 1 / suspiciousPaymentMultiplier;
    // For multiplier 5.0, use exclusive boundary; for others, use inclusive
    const lowerBoundExclusive = Math.abs(suspiciousPaymentMultiplier - 5.0) < 0.01;

    if (
      ratio >= suspiciousPaymentMultiplier ||
      (lowerBoundExclusive ? ratio < lowerThreshold : ratio <= lowerThreshold)
    ) {
      reasons.push(
        `Unusual payment amount (ratio ${ratio.toFixed(2)}, threshold ${suspiciousPaymentMultiplier.toFixed(1)}×)`,
      );
    }
  }

  if (reasons.length > 0) {
    return { suspicious: true, reason: reasons.join("; ") };
  }
  return { suspicious: false, reason: null };
}

/**
 * Verify a single transaction hash against a specific school wallet.
 * Handles fee-bump transactions by unwrapping to the inner transaction.
 * Throws structured errors for all failure cases.
 *
 * Error codes:
 *   NOT_FOUND (404)           — txHash does not exist on Horizon
 *   HORIZON_UNAVAILABLE (503) — Horizon unreachable / rate-limited / 5xx
 *   TX_FAILED (400)           — transaction found but failed on-chain
 *   MISSING_MEMO (400)        — no memo on the transaction (MEMO_NONE)
 *   UNSUPPORTED_MEMO_TYPE (400) — memo type is not MEMO_TEXT
 *   INVALID_DESTINATION (400) — no payment op to the school wallet
 *   UNSUPPORTED_ASSET (400)   — asset not accepted
 *   AMOUNT_TOO_LOW/HIGH (400) — outside configured limits
 */
async function verifyTransaction(txHash, walletAddress, schoolId = null) {
  const tx = await withStellarRetry(
    () => server.transactions().transaction(txHash).call(),
    { label: "verifyTransaction" },
  );

  // 1. Validate transaction success
  if (tx.successful === false) {
    const err = new Error(
      "Transaction was not successful on the Stellar network",
    );
    err.code = "TX_FAILED";
    throw err;
  }

  // Unwrap fee-bump transaction to get the inner transaction
  const innerTx = tx.inner_transaction || tx;

  // 2. Find matching payment operation first (destination + asset checks before memo)
  const ops = await withStellarRetry(() => innerTx.operations(), {
    label: "verifyTransaction.operations",
  });
  const payOp = ops.records.find(
    (op) => op.type === "payment" && op.to === walletAddress,
  );
  if (!payOp) {
    const err = new Error(
      `No payment operation found targeting the school wallet (${walletAddress})`,
    );
    err.code = "INVALID_DESTINATION";
    throw err;
  }

  const asset = detectAsset(payOp);
  if (!asset) {
    const assetCode =
      payOp.asset_type === "native"
        ? "XLM"
        : payOp.asset_code || payOp.asset_type;
    const err = new Error(`Unsupported asset: ${assetCode}`);
    err.code = "UNSUPPORTED_ASSET";
    err.assetCode = assetCode;
    throw err;
  }

  // 3. Check memo type (after destination/asset are validated)
  const memoType = innerTx.memo_type || 'none';

  if (memoType === 'none') {
    const err = new Error(
      "Transaction memo is missing or empty — cannot identify student",
    );
    err.code = "MISSING_MEMO";
    throw err;
  }

  // MEMO_ID and MEMO_HASH are decoded back to the canonical intent memo (#1118)
  // so wallets that cannot send free-text memos still match. MEMO_RETURN has no
  // encoding and stays unsupported.
  if (!normalizeMemoType(memoType)) {
    const err = new Error(
      `Transaction memo type '${memoType}' is not supported. Accepted types: ${SUPPORTED_MEMO_TYPES.join(', ')}.`,
    );
    err.code = "UNSUPPORTED_MEMO_TYPE";
    err.memoType = memoType;
    throw err;
  }

  const memo = decodeMemoToCanonical(innerTx.memo, memoType);
  if (!memo) {
    // A non-text memo that fails to decode carries no student identity — it is
    // an unrecognised value rather than a missing one, so report it as such.
    if (normalizeMemoType(memoType) !== 'MEMO_TEXT') {
      const err = new Error(
        `Transaction memo of type '${memoType}' could not be decoded to a payment reference.`,
      );
      err.code = "UNSUPPORTED_MEMO_TYPE";
      err.memoType = memoType;
      throw err;
    }
    const err = new Error(
      "Transaction memo is missing or empty — cannot identify student",
    );
    err.code = "MISSING_MEMO";
    throw err;
  }

  const amount = normalizeAmount(payOp.amount);

  // 5. Validate payment amount is within configured limits
  const limitValidation = await validatePaymentAmount(amount, {
    schoolId,
    asset: asset?.code,
  });
  if (!limitValidation.valid) {
    const err = new Error(limitValidation.error);
    err.code = limitValidation.code;
    throw err;
  }

  // 6. Look up student to validate fee. School-scope when schoolId is provided so
  //    the same studentId string used across two schools resolves to the correct one.
  const studentQuery = schoolId ? { schoolId, studentId: memo } : { studentId: memo };
  const student = await Student.findOne(studentQuery);
  const feeAmount = student ? student.feeAmount : null;

  const feeValidation =
    feeAmount != null
      ? validatePaymentAgainstFee(amount, feeAmount)
      : {
        status: "unknown",
        excessAmount: 0,
        message: "Student not found, cannot validate fee",
      };

  // Extract network fee from transaction
  const networkFee = parseFloat(tx.fee_paid || "0") / 10000000; // Convert stroops to XLM

  return {
    hash: tx.hash,
    memo: memo,
    studentId: memo,
    amount: amount,
    assetCode: asset.assetCode,
    assetType: asset.assetType,
    feeAmount,
    feeValidation,
    networkFee,
    date: tx.created_at,
    ledger: tx.ledger_attr || tx.ledger || null,
    senderAddress: payOp.from || null,
  };
}

/**
 * Fetch recent transactions for a specific school wallet and record new payments.
 * Returns a summary object with counts for each outcome category.
 * Paginates through ALL transactions (200 per page) until an already-processed
 * transaction is encountered, ensuring no payments are missed after downtime.
 *
 * @param {object} school - School document with { schoolId, stellarAddress }
 * @returns {object} summary - { found, new: newCount, matched, unmatched, failed, alreadyProcessed, failedDetails }
 */
async function syncPaymentsForSchool(school) {
  const { schoolId, stellarAddress } = school;

  // Summary counters
  const summary = {
    found: 0,
    new: 0,
    matched: 0,
    unmatched: 0,
    failed: 0,
    alreadyProcessed: 0,
    failedDetails: [],   // [{ txHash, reason }]
  };

  // Fetch up to 200 transactions per page (Horizon API maximum).
  // Pagination continues until we hit an already-recorded transaction or
  // exhaust all pages — fixing the previous limit(20) single-fetch bug.
  let page = await withStellarRetry(
    () =>
      server
        .transactions()
        .forAccount(stellarAddress)
        .order("desc")
        .limit(200)
        .call(),
    { label: `syncPaymentsForSchool(${schoolId})` },
  );

  let done = false;
  let newPayments = 0;
  while (!done) {
    for (const tx of page.records) {
      summary.found++;

      const existing = await Payment.findOne({ txHash: tx.hash, deletedAt: null });
      if (existing) { summary.alreadyProcessed++; done = true; break; }

      summary.new++;

      const valid = await extractValidPayment(tx, stellarAddress);
      if (!valid) {
        // Log if the tx was skipped due to wrong destination
        if (tx.successful) {
          const ops = await withStellarRetry(
            () => tx.operations(),
            { label: 'syncPaymentsForSchool.destinationCheck' }
          ).catch(() => ({ records: [] }));
          const wrongDest = ops.records.find(
            op => op.type === 'payment' && op.to && op.to !== stellarAddress
          );
          if (wrongDest) {
            logger.warn('Transaction skipped — destination does not match school wallet', {
              txHash: tx.hash, schoolId,
              destination: wrongDest.to,
              expected: stellarAddress,
            });
            summary.failed++;
            summary.failedDetails.push({ txHash: tx.hash, reason: `INVALID_DESTINATION: payment sent to ${wrongDest.to}, expected ${stellarAddress}` });
            continue;
          }
        }
        summary.unmatched++;
        continue;
      }

      // `asset` is destructured for the per-asset limit lookup (#1117).
      const { payOp, memo, asset } = valid;

      // Explicit destination check — defence-in-depth beyond extractValidPayment
      if (payOp.to !== stellarAddress) {
        logger.warn('Transaction skipped — destination mismatch after extraction', {
          txHash: tx.hash, schoolId, destination: payOp.to, expected: stellarAddress,
        });
        summary.failed++;
        summary.failedDetails.push({ txHash: tx.hash, reason: `INVALID_DESTINATION: payment sent to ${payOp.to}` });
        continue;
      }

      // Decouple crediting from intent existence (#848): a pending intent is the
      // preferred path, but if none exists (expired or never created) we fall back
      // to matching by memo (= studentId) directly. This ensures a late-but-valid
      // on-chain payment is always credited even after the intent TTL'd away.
      const intent = await PaymentIntent.findOne({ schoolId, memo, status: 'pending' });
      let student;
      if (intent) {
        student = await Student.findOne({ schoolId, studentId: intent.studentId });
      } else {
        student = await Student.findOne({ schoolId, studentId: memo });
      }
      if (!student) { summary.unmatched++; continue; }

      summary.matched++;

      const paymentAmount = parseFloat(payOp.amount);

      const limitValidation = await validatePaymentAmount(paymentAmount, {
        schoolId,
        asset: asset?.code,
      });
      if (!limitValidation.valid) {
        summary.failed++;
        summary.failedDetails.push({ txHash: tx.hash, reason: limitValidation.code });
        continue;
      }

      const senderAddress = payOp.from || null;
      const txDate = new Date(tx.created_at);
      const txLedger = tx.ledger_attr || tx.ledger || null;

      const collision = await detectMemoCollision(
        memo,
        senderAddress,
        paymentAmount,
        student.feeAmount,
        txDate,
        schoolId,
      );
      const crossSchoolCollision = await detectCrossSchoolMemoCollision(
        memo,
        schoolId,
        txDate,
      );
      const isSuspicious = collision.suspicious || crossSchoolCollision.suspicious;
      const suspicionReason =
        [collision.reason, crossSchoolCollision.reason].filter(Boolean).join('; ') || null;

      const confirmation = await determineConfirmationState(
        txLedger,
        CONFIRMATION_STATES.DETECTED,
        isSuspicious,
      );
      const isConfirmed = isConfirmedOrAbove(confirmation.state);
      const confirmationStatus = confirmation.confirmationStatus;

      const studentId = student.studentId;
      // Fee amount and category come from the intent when one exists; otherwise
      // fall back to the student's current fee record (intent-decoupled crediting).
      const feeAmountForRecord = intent ? intent.amount : student.feeAmount;
      const feeCategory = intent ? (intent.feeCategory || null) : null;

      const previousPayments = await Payment.aggregate([
        { $match: { schoolId, studentId, deletedAt: null } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      const previousTotal = previousPayments.length
        ? previousPayments[0].total
        : 0;
      const cumulativeTotal = parseFloat(
        (previousTotal + paymentAmount).toFixed(7),
      );

      // Partial payments are accepted in the sync path — cumulative total determines status.
      // A single payment below the fee is recorded as 'partial' (credit toward remainingBalance).
      // Compare in exact stroop space (#842) so an exact cumulative match is never
      // mis-classified as partial/overpaid by a float rounding epsilon.
      const cumulativeVsFee = compareAmounts(cumulativeTotal, student.feeAmount);
      let cumulativeStatus;
      if (cumulativeVsFee < 0) cumulativeStatus = "partial";
      else if (cumulativeVsFee > 0) cumulativeStatus = "overpaid";
      else cumulativeStatus = "valid";

      const excessAmount =
        cumulativeStatus === "overpaid"
          ? stroopsToNumber(toStroops(cumulativeTotal) - toStroops(student.feeAmount))
          : 0;

      let session;
      try {
        session = await mongoose.connection.startSession();
        await session.withTransaction(async () => {
          await savePayment({
            schoolId,
            studentId,
            txHash: tx.hash,
            correlationId: deriveCorrelationId(tx.hash),
            amount: paymentAmount,
            feeAmount: feeAmountForRecord,
            feeCategory,
            feeValidationStatus: cumulativeStatus,
            excessAmount,
            status: "SUCCESS",
            memo,
            senderAddress,
            isSuspicious,
            suspicionReason,
            ledger: txLedger,
            ledgerSequence: txLedger,
            confirmationStatus,
            confirmationState: confirmation.state,
            confirmedAt: txDate,
          }, { session });

          if (isConfirmed && !isSuspicious) {
            const updateData = {
              totalPaid: cumulativeTotal,
              remainingBalance: parseFloat(Math.max(0, student.feeAmount - cumulativeTotal).toFixed(7)),
              feePaid: cumulativeTotal >= student.feeAmount,
            };

            if (feeCategory && student.fees && student.fees.length > 0) {
              const feeIndex = student.fees.findIndex(f => f.category === feeCategory);
              if (feeIndex !== -1) {
                const categoryPayments = await Payment.aggregate([
                  {
                    $match: {
                      schoolId,
                      studentId,
                      feeCategory,
                      confirmationStatus: "confirmed",
                      isSuspicious: false,
                      deletedAt: null,
                    },
                  },
                  { $group: { _id: null, total: { $sum: "$amount" } } },
                ]).session(session);
                const categoryTotalPaid = categoryPayments.length
                  ? parseFloat(categoryPayments[0].total.toFixed(7))
                  : 0;

                student.fees[feeIndex].totalPaid = categoryTotalPaid;
                student.fees[feeIndex].remainingBalance = Math.max(
                  0,
                  student.fees[feeIndex].amount - categoryTotalPaid
                );
                student.fees[feeIndex].paid = categoryTotalPaid >= student.fees[feeIndex].amount;
                updateData.fees = student.fees;
              }
            }

            await Student.findOneAndUpdate(
              { schoolId, studentId },
              updateData,
              { session }
            );
          }

          if (intent) {
            await PaymentIntent.findByIdAndUpdate(
              intent._id,
              { status: "completed" },
              { session }
            );
          }
        });
      } catch (saveErr) {
        if (saveErr.code === 'DUPLICATE_TX') {
          // Another concurrent path (poller or verify) already recorded this tx.
          // Treat as already-processed rather than an error.
          summary.new--;
          summary.alreadyProcessed++;
          if (intent) {
            await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'completed' });
          }
          continue;
        }
        throw saveErr;
      } finally {
        if (session) await session.endSession();
      }
      newPayments++;

      logger.info("Transaction recorded", {
        txHash: tx.hash,
        schoolId,
        studentId,
        amount: paymentAmount,
        feeValidationStatus: cumulativeStatus,
        isSuspicious,
        confirmationStatus,
        confirmationState: confirmation.state,
        intentMatched: Boolean(intent),
      });
    }

    if (!done) {
      if (page.records.length < 200) break; // last page
      page = await withStellarRetry(() => page.next(), {
        label: `syncPaymentsForSchool.next(${schoolId})`,
      });
      if (!page || !page.records.length) break;
    }
  }

  return summary;
}

/**
 * Re-check all non-terminal payments for a school and advance each one
 * (detected/pending -> confirmed -> finalized) per the finality policy
 * (issue #747). Safe to call repeatedly/concurrently for the same school:
 * `determineConfirmationState` is idempotent, so a re-run over an unchanged
 * ledger range leaves already-resolved payments untouched.
 *
 * Falls back to the legacy `confirmationStatus` field for payments written
 * before `confirmationState` existed, so older pending records keep getting
 * swept without a separate migration step.
 *
 * @param {string} schoolId
 */
async function finalizeConfirmedPayments(schoolId) {
  const pending = await Payment.find({
    schoolId,
    isSuspicious: false,
    $or: [
      { confirmationState: { $in: [CONFIRMATION_STATES.DETECTED, CONFIRMATION_STATES.PENDING, CONFIRMATION_STATES.CONFIRMED] } },
      { confirmationState: { $exists: false }, confirmationStatus: "pending_confirmation" },
    ],
  });

  for (const payment of pending) {
    const txLedger = payment.ledgerSequence || payment.ledger;
    if (!txLedger) continue;

    const currentState = payment.confirmationState || CONFIRMATION_STATES.DETECTED;
    const { state: nextState, changed } = await determineConfirmationState(
      txLedger,
      currentState,
      payment.isSuspicious,
    );
    if (!changed) continue;

    if (typeof Payment.findByIdAndUpdate === "function") {
      await Payment.findByIdAndUpdate(payment._id, {
        confirmationState: nextState,
        confirmationStatus: deriveLegacyConfirmationStatus(nextState),
      });
    }

    if (!isConfirmedOrAbove(nextState)) continue;

    const student = await Student.findOne({
      schoolId,
      studentId: payment.studentId,
    });
    if (!student) continue;

    const agg = await Payment.aggregate([
      {
        $match: {
          schoolId,
          studentId: payment.studentId,
          confirmationStatus: "confirmed",
          isSuspicious: false,
          deletedAt: null,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalPaid = agg.length ? parseFloat(agg[0].total.toFixed(7)) : 0;
    const remainingBalance = parseFloat(
      Math.max(0, student.feeAmount - totalPaid).toFixed(7),
    );

    const updateData = { totalPaid, remainingBalance, feePaid: totalPaid >= student.feeAmount };

    // Update fee categories if they exist
    if (student.fees && student.fees.length > 0) {
      const categoryPayments = await Payment.aggregate([
        {
          $match: {
            schoolId,
            studentId: payment.studentId,
            feeCategory: { $ne: null },
            confirmationStatus: "confirmed",
            isSuspicious: false,
            deletedAt: null,
          },
        },
        {
          $group: {
            _id: "$feeCategory",
            totalPaid: { $sum: "$amount" },
          },
        },
      ]);

      const categoryPaymentMap = {};
      categoryPayments.forEach(cp => {
        categoryPaymentMap[cp._id] = parseFloat(cp.totalPaid.toFixed(7));
      });

      // Update each fee category
      student.fees.forEach(fee => {
        const paid = categoryPaymentMap[fee.category] || 0;
        fee.totalPaid = paid;
        fee.remainingBalance = Math.max(0, fee.amount - paid);
        fee.paid = paid >= fee.amount;
      });

      updateData.fees = student.fees;
    }

    await Student.findOneAndUpdate(
      { schoolId, studentId: payment.studentId },
      updateData,
    );
  }
}

/**
 * Parse an incoming Stellar transaction for memo and payment amounts.
 * If walletAddress is provided, only payments to that wallet are included.
 */
async function parseIncomingTransaction(txHash, walletAddress = null) {
  let tx;
  try {
    tx = await withStellarRetry(
      () => server.transactions().transaction(txHash).call(),
      { label: "parseIncomingTransaction" },
    );
  } catch (err) {
    throw classifyHorizonError(err, `Transaction ${txHash}`);
  }

  const memo = tx.memo ? tx.memo.trim() : null;

  let ops;
  try {
    ops = await withStellarRetry(() => tx.operations(), {
      label: "parseIncomingTransaction.operations",
    });
  } catch (err) {
    throw classifyHorizonError(err, "Transaction operations");
  }
  const payments = ops.records
    .filter(
      (op) =>
        op.type === "payment" && (!walletAddress || op.to === walletAddress),
    )
    .map((op) => ({
      from: op.from || null,
      to: op.to,
      amount: normalizeAmount(op.amount),
      assetCode: op.asset_type === "native" ? "XLM" : op.asset_code,
      assetType: op.asset_type,
      assetIssuer: op.asset_issuer || null,
    }));

  return {
    hash: tx.hash,
    successful: tx.successful,
    memo,
    payments,
    created_at: tx.created_at,
  };
}

module.exports = {
  syncPaymentsForSchool,
  finalizeConfirmedPayments,
  verifyTransaction,
  parseIncomingTransaction,
  validatePaymentAgainstFee,
  detectAsset,
  normalizeAmount,
  extractValidPayment,
  detectMemoCollision,
  detectCrossSchoolMemoCollision,
  detectAbnormalPatterns,
  computeHistoricalAmountStats,
  checkConfirmationStatus,
  // Consumed by transactionPollingService (import + call) and covered by tests —
  // must be exported or those callers invoke `undefined`.
  determineConfirmationState,
  // recordPayment was moved to transactionService.savePayment (db layer split);
  // re-exported under its original name since paymentController, retryService,
  // transactionQueueService, and transactionRetryQueue still import it from here.
  recordPayment: savePayment,
};
