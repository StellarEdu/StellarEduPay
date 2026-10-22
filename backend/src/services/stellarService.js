"use strict";

// Issue #1557 — path payments deliver funds to the school wallet just like a
// plain payment (the destination amount/asset are on the operation), so they
// must be credited too. Previously only type "payment" was accepted.
const CREDITABLE_OP_TYPES = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);
function isCreditableOpType(type) {
  return CREDITABLE_OP_TYPES.has(type);
}

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
const { toStroops, stroopsToNumber } = require("../utils/stellarAmount");
const { classifyFeePayment } = require("../utils/money");
const {
  SUPPORTED_MEMO_TYPES,
  normalizeMemoType,
  decodeMemoToCanonical,
} = require("../utils/stellarMemo");
const { withStellarRetry } = require("../utils/withStellarRetry");
const { savePayment } = require("./transactionService");
const { deriveCorrelationId } = require("../utils/correlationId");
const lock = require("./distributedLock");
const {
  CONFIRMATION_STATES,
  computeTargetState,
  resolveNextState,
  deriveLegacyConfirmationStatus,
  isConfirmedOrAbove,
} = require("./paymentConfirmationStateMachine");
const logger = require("../utils/logger").child("StellarService");
const { getEngineForSchool } = require("./feeAdjustmentEngine");
const { updateStudentBalance } = require("../utils/studentBalanceUpdater");
const { recordUnmatchedPayment } = require("./unmatchedPaymentService");
const { PAYMENT_TYPES } = require("./paymentService");

// TTL for the per-student balance lock (#1026), shared with paymentController's
// verifyPayment. Guards the read-aggregate-then-write sequence that computes
// cumulativeTotal and writes it as an absolute Student.$set — unsafe to run
// concurrently for the same student, whether the other writer is verifyPayment
// or another syncPaymentsForSchool run.
const STUDENT_BALANCE_LOCK_TTL_MS = parseInt(process.env.STUDENT_BALANCE_LOCK_TTL_MS || "15000", 10);

/**
 * Resolve the asset actually delivered to the destination of an operation.
 * Path payments carry the delivered asset in `destination_asset_*` and the
 * delivered amount in `destination_amount`; plain payments use `asset_*` and
 * `amount`.
 */
function resolveDeliveredAsset(op) {
  const isPathPayment =
    op.type === "path_payment_strict_send" ||
    op.type === "path_payment_strict_receive";
  if (isPathPayment) {
    const assetType = op.destination_asset_type;
    const assetCode = assetType === "native" ? "XLM" : op.destination_asset_code;
    const assetIssuer = assetType === "native" ? null : op.destination_asset_issuer;
    return { assetType, assetCode, assetIssuer };
  }
  const assetType = op.asset_type;
  const assetCode = assetType === "native" ? "XLM" : op.asset_code;
  const assetIssuer = assetType === "native" ? null : op.asset_issuer;
  return { assetType, assetCode, assetIssuer };
}

/**
 * Amount credited to the destination for an operation. Path payments credit
 * `destination_amount`; plain payments credit `amount`.
 */
function resolveCreditedAmount(op) {
  const isPathPayment =
    op.type === "path_payment_strict_send" ||
    op.type === "path_payment_strict_receive";
  return isPathPayment ? op.destination_amount : op.amount;
}

function detectAsset(payOp) {
  const { assetType, assetCode, assetIssuer } = resolveDeliveredAsset(payOp);
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

  // #1556 — Fee-bump transactions: Horizon exposes memo_type, memo and the
  // operations() link on the TOP-LEVEL transaction record regardless of whether
  // it is a fee-bump or a regular transaction. The inner_transaction sub-object
  // only carries { hash, signatures, max_fee } — it does NOT have memo_type,
  // memo, or operations(). Reading those from inner_transaction always yields
  // undefined / TypeError, so fee-bumped payments were silently dropped.
  // Fix: always use the top-level `tx` for memo/operations. The inner hash is
  // preserved separately for traceability when it differs.
  const isFeeBomp = Boolean(tx.inner_transaction);
  const innerHash = isFeeBomp ? tx.inner_transaction.hash : null;

  // Check memo type and handle accordingly
  const memoType = tx.memo_type || 'none';
  
  if (memoType === 'none') {
    // No memo provided
    return null;
  }
  
  if (!normalizeMemoType(memoType)) {
    // MEMO_RETURN — no canonical encoding, so it cannot identify a payment.
    logger.warn('Transaction has unsupported memo type', {
      txHash: tx.hash,
      innerHash,
      memoType,
      memo: tx.memo,
    });
    return null;
  }

  // MEMO_ID / MEMO_HASH decode back to the canonical intent memo (#1118).
  const memo = decodeMemoToCanonical(tx.memo, memoType);
  if (!memo) {
    logger.warn('Transaction memo could not be decoded to a payment reference', {
      txHash: tx.hash,
      innerHash,
      memoType,
    });
    return null;
  }

  const ops = await fetchAllOperations(tx, "extractValidPayment.operations");
  // #840 — only a successful payment/path-payment operation landing on the
  // school wallet is creditable. detectAsset then enforces the asset/issuer
  // (#841): a wrong-asset or fake-issuer operation yields null and is rejected.
  // #1760 — every creditable operation is returned with its opIndex so each one
  // is recorded as its own payment row.
  const creditable = ops
    .map((op, i) => ({ op, opIndex: i }))
    .filter(({ op }) => isCreditableOpType(op.type) && op.to === walletAddress)
    .map(({ op, opIndex }) => {
      const asset = detectAsset(op);
      if (!asset) return null;
      return {
        payOp: op,
        opIndex,
        amount: normalizeAmount(resolveCreditedAmount(op)),
        asset,
      };
    })
    .filter(Boolean);

  if (!creditable.length) return null;

  return { operations: creditable, memo, memoType, innerHash };
}

/**
 * Fetch every operation of a transaction, following Horizon pagination.
 * Horizon returns 10 records per page by default and a transaction may contain
 * up to 100 operations (#1760) — a single `tx.operations()` call would silently
 * drop everything past the first page.
 *
 * @param {object} tx - Horizon transaction record
 * @param {string} label - retry label for logging
 * @returns {Promise<Array>} all operation records in order
 */
async function fetchAllOperations(tx, label) {
  let page = await withStellarRetry(() => tx.operations({ limit: 200 }), {
    label,
    context: `Transaction ${tx.hash} operations`,
  });
  const records = [...page.records];
  while (page.records.length > 0 && typeof page.next === "function") {
    page = await withStellarRetry(() => page.next(), {
      label: `${label}.next`,
      context: `Transaction ${tx.hash} operations page`,
    });
    if (!page || !page.records.length) break;
    records.push(...page.records);
  }
  return records;
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

/**
 * Calculate adjusted fee using the DynamicFeeAdjustmentEngine and validate payment.
 * Issue #1474: Wires the fee adjustment engine into the live payment validation path.
 *
 * @param {string} schoolId - School ID for tenant isolation
 * @param {number} paymentAmount - The amount the student paid
 * @param {number} baseFee - The base fee amount
 * @param {Object} context - Fee calculation context (promoCode, isEarly, etc.)
 * @returns {Object} Validation result with status, finalFee, and adjustments
 */
function validatePaymentWithDynamicFee(schoolId, paymentAmount, baseFee, context = {}) {
  try {
    const engine = getEngineForSchool(schoolId);
    const feeCalculation = engine.calculateFee({
      baseAmount: baseFee,
      schoolId,
      ...context,
    });

    const finalFee = feeCalculation.finalFee;
    const validation = validatePaymentAgainstFee(paymentAmount, finalFee);

    return {
      ...validation,
      baseFee,
      finalFee,
      adjustments: feeCalculation.adjustments,
      effectiveRate: feeCalculation.effectiveRate,
    };
  } catch (err) {
    logger.error('Fee adjustment engine error', {
      schoolId,
      paymentAmount,
      baseFee,
      error: err.message,
    });

    // Fallback to non-adjusted fee validation on engine error
    return {
      ...validatePaymentAgainstFee(paymentAmount, baseFee),
      baseFee,
      finalFee: baseFee,
      adjustments: [],
      fallbackToBaseFee: true,
    };
  }
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
 *
 * The senderAddress predicate uses $nin to express "not this sender and not
 * null" in a single operator, avoiding the duplicate-key bug that previously
 * caused { $ne: senderAddress, $exists: true, $ne: null } to collapse to
 * { $exists: true, $ne: null } at JS parse time (ESLint no-dupe-keys, #1271).
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
    // $nin expresses "not senderAddress AND not null" without a duplicate $ne key.
    // $exists: true additionally excludes documents where the field is absent.
    senderAddress: { $nin: [senderAddress, null], $exists: true },
    confirmedAt: { $gte: windowStart },
    deletedAt: { $in: [null, undefined] },
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
    { label: "verifyTransaction", context: `Transaction ${txHash}` },
  );

  // 1. Validate transaction success
  if (tx.successful === false) {
    const err = new Error(
      "Transaction was not successful on the Stellar network",
    );
    err.code = "TX_FAILED";
    throw err;
  }

  // #1556 — Fee-bump transactions: memo_type, memo and operations() all live
  // on the TOP-LEVEL tx record. inner_transaction only contains { hash,
  // signatures, max_fee }. Preserve the inner hash for traceability but never
  // read memo/operations from it.
  const innerHash = tx.inner_transaction ? tx.inner_transaction.hash : null;

  // 2. Find matching payment operations first (destination + asset checks before memo)
  // #1760 — collect every creditable operation with its opIndex, not just the first.
  const ops = await fetchAllOperations(tx, "verifyTransaction.operations");
  const creditable = ops
    .map((op, i) => ({ op, opIndex: i }))
    .filter(({ op }) => isCreditableOpType(op.type) && op.to === walletAddress);
  if (!creditable.length) {
    const err = new Error(
      `No payment operation found targeting the school wallet (${walletAddress})`,
    );
    err.code = "INVALID_DESTINATION";
    throw err;
  }

  const operations = [];
  for (const { op, opIndex } of creditable) {
    const asset = detectAsset(op);
    if (!asset) {
      const { assetType, assetCode: rawCode } = resolveDeliveredAsset(op);
      const assetCode = assetType === "native" ? "XLM" : rawCode || assetType;
      const err = new Error(`Unsupported asset: ${assetCode}`);
      err.code = "UNSUPPORTED_ASSET";
      err.assetCode = assetCode;
      throw err;
    }
    operations.push({
      opIndex,
      amount: normalizeAmount(resolveCreditedAmount(op)),
      asset,
      senderAddress: op.from || null,
    });
  }

  // 3. Check memo type (after destination/asset are validated)
  const memoType = tx.memo_type || 'none';

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

  const memo = decodeMemoToCanonical(tx.memo, memoType);
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

  // #1760 — a single memo covers every operation in the transaction, so the
  // credited amount is the sum of all creditable operations (attribution is
  // per-transaction until per-operation memos/muxed accounts are supported).
  const amount = parseFloat(
    operations.reduce((sum, o) => sum + o.amount, 0).toFixed(7),
  );

  // 5. Validate payment amount is within configured limits
  // #1555 — detectAsset returns { assetCode, assetType, assetIssuer }.
  // The previous `asset?.code` was always undefined, causing every USDC
  // payment to be validated against XLM limits. Use `assetCode` instead.
  // #1760 — validate each operation's amount against its own asset's limits.
  for (const o of operations) {
    const limitValidation = await validatePaymentAmount(o.amount, {
      schoolId,
      asset: o.asset?.assetCode,
    });
    if (!limitValidation.valid) {
      const err = new Error(limitValidation.error);
      err.code = limitValidation.code;
      throw err;
    }
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

  const primary = operations[0];

  return {
    hash: tx.hash,
    innerHash,
    memo: memo,
    studentId: memo,
    amount: amount,
    assetCode: primary.asset.assetCode,
    assetType: primary.asset.assetType,
    feeAmount,
    feeValidation,
    networkFee,
    date: tx.created_at,
    ledger: tx.ledger_attr || tx.ledger || null,
    senderAddress: primary.senderAddress,
    // #1760 — every creditable operation, each with its opIndex and amount.
    operations: operations.map((o) => ({
      opIndex: o.opIndex,
      amount: o.amount,
      assetCode: o.asset.assetCode,
      assetType: o.asset.assetType,
      senderAddress: o.senderAddress,
    })),
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
    { label: `syncPaymentsForSchool(${schoolId})`, context: `Account ${stellarAddress} transactions` },
  );

  let done = false;
  let newPayments = 0;
  while (!done) {
    for (const tx of page.records) {
      summary.found++;

      const existing = await Payment.findOne({ txHash: tx.hash, schoolId, deletedAt: null });
      if (existing) { summary.alreadyProcessed++; done = true; break; }

      summary.new++;

      const valid = await extractValidPayment(tx, stellarAddress);
      if (!valid) {
        // Log if the tx was skipped due to wrong destination
        if (tx.successful) {
          const ops = await fetchAllOperations(tx, 'syncPaymentsForSchool.destinationCheck')
            .then((records) => ({ records }))
            .catch(() => ({ records: [] }));
          const wrongDest = ops.records.find(
            op => isCreditableOpType(op.type) && op.to && op.to !== stellarAddress
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

      // #1760 — every creditable operation is credited individually, each with
      // its own opIndex. A shared memo attributes the sum of the operations to
      // the one student the memo identifies.
      const { operations, memo } = valid;

      // Explicit destination check — defence-in-depth beyond extractValidPayment
      const wrongDestOp = operations.find((o) => o.payOp.to !== stellarAddress);
      if (wrongDestOp) {
        logger.warn('Transaction skipped — destination mismatch after extraction', {
          txHash: tx.hash, schoolId, destination: wrongDestOp.payOp.to, expected: stellarAddress,
        });
        summary.failed++;
        summary.failedDetails.push({ txHash: tx.hash, reason: `INVALID_DESTINATION: payment sent to ${wrongDestOp.payOp.to}` });
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

      // A memo (or a still-pending intent) can point at a student who has since
      // been soft-deleted (#77/#390). The funds already left the payer's wallet,
      // so record them against the deleted student (studentDeleted=true) for the
      // existing deleted-student payments audit view (getDeletedStudentPayments)
      // instead of dropping them into the generic unmatched bucket, where they'd
      // be indistinguishable from a mistyped memo and never surfaced for review.
      let studentDeleted = false;
      if (!student) {
        const targetStudentId = intent ? intent.studentId : memo;
        student = await Student.findOne({
          schoolId,
          studentId: targetStudentId,
          deletedAt: { $ne: null },
        });
        studentDeleted = Boolean(student);
        if (studentDeleted) {
