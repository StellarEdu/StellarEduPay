'use strict';

const { server } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');

const CHAIN_PAGE_SIZE = 200;
const CHAIN_MAX_PAGES = 50; // hard ceiling so a stuck cursor can't loop forever
const DEFAULT_CHAIN_LOOKBACK_DAYS = parseInt(process.env.RECONCILIATION_CHAIN_LOOKBACK_DAYS, 10) || 90;

/**
 * Fetch transactions for a given wallet address from Horizon, paging with a
 * cursor (consistent with transactionPollingService) instead of a single
 * 200-record page. Stops once transactions older than `lookbackDays` are
 * reached, so large, long-lived wallets don't get scanned back to genesis.
 *
 * @param {string} walletAddress
 * @param {{ lookbackDays?: number }} [options] lookbackDays <= 0 disables the window.
 */
async function fetchChainTransactions(walletAddress, { lookbackDays = DEFAULT_CHAIN_LOOKBACK_DAYS } = {}) {
  const cutoff = lookbackDays > 0 ? Date.now() - lookbackDays * 24 * 60 * 60 * 1000 : null;
  const records = [];
  let cursor = null;

  for (let page = 0; page < CHAIN_MAX_PAGES; page++) {
    let builder = server.transactions().forAccount(walletAddress).order('desc').limit(CHAIN_PAGE_SIZE);
    if (cursor) builder = builder.cursor(cursor);

    const result = await builder.call();
    const batch = result.records || [];
    if (batch.length === 0) break;

    for (const tx of batch) {
      if (cutoff && new Date(tx.created_at).getTime() < cutoff) {
        return records; // reached the lookback boundary — stop paginating
      }
      records.push(tx);
      cursor = tx.paging_token;
    }

    if (batch.length < CHAIN_PAGE_SIZE) break; // drained
  }

  return records;
}

/**
 * Check consistency for a single school.
 *
 * @param {{ schoolId: string, stellarAddress: string }} school
 */
async function checkSchoolConsistency({ schoolId, stellarAddress }) {
  const [dbPayments, chainTxs] = await Promise.all([
    Payment.find({ schoolId }).lean(),
    fetchChainTransactions(stellarAddress),
  ]);

  // Build a map of txHash → on-chain tx for O(1) lookup
  const chainMap = new Map();
  for (const tx of chainTxs) {
    const ops = await tx.operations();
    const payOp = ops.records.find(
      (op) => op.type === 'payment' && op.to === stellarAddress
    );
    if (payOp) {
      chainMap.set(tx.hash, {
        hash: tx.hash,
        memo: tx.memo ? tx.memo.trim() : null,
        amount: parseFloat(parseFloat(payOp.amount).toFixed(7)),
      });
    }
  }

  const mismatches = [];

  for (const payment of dbPayments) {
    const onChain = chainMap.get(payment.txHash);

    if (!onChain) {
      mismatches.push({
        type: 'missing_on_chain',
        txHash: payment.txHash,
        studentId: payment.studentId,
        dbAmount: payment.amount,
        message: `Transaction ${payment.txHash} exists in DB but not found on-chain`,
      });
      continue;
    }

    if (Math.abs(onChain.amount - payment.amount) > 0.0000001) {
      mismatches.push({
        type: 'amount_mismatch',
        txHash: payment.txHash,
        studentId: payment.studentId,
        dbAmount: payment.amount,
        chainAmount: onChain.amount,
        message: `Amount mismatch for ${payment.txHash}: DB=${payment.amount}, chain=${onChain.amount}`,
      });
    }

    if (onChain.memo && onChain.memo !== payment.studentId) {
      mismatches.push({
        type: 'student_mismatch',
        txHash: payment.txHash,
        dbStudentId: payment.studentId,
        chainMemo: onChain.memo,
        message: `Student mismatch for ${payment.txHash}: DB studentId=${payment.studentId}, chain memo=${onChain.memo}`,
      });
    }
  }

  const balanceMismatches = await checkStudentBalanceConsistency(schoolId);
  mismatches.push(...balanceMismatches);

  return {
    schoolId,
    totalDbPayments: dbPayments.length,
    totalChainTxsScanned: chainMap.size,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

/**
 * Compare DB payments against on-chain transactions for ALL active schools.
 *
 * Mismatch types:
 *  - missing_on_chain : payment recorded in DB but not found on Stellar
 *  - amount_mismatch  : DB amount differs from on-chain amount
 *  - student_mismatch : DB studentId doesn't match the tx memo
 */
async function checkStudentBalanceConsistency(schoolId) {
  const students = await Student.find({ schoolId, deletedAt: null }).lean();
  const mismatches = [];

  for (const student of students) {
    const [agg] = await Payment.aggregate([
      { $match: { schoolId, studentId: student.studentId, status: 'SUCCESS', deletedAt: null } },
      { $group: { _id: null, computedTotal: { $sum: '$amount' } } },
    ]);

    // creditAdjustments represents cumulative manual partial-credit overrides
    // applied by admins. They are intentional deviations from the raw payment
    // sum and must be included in the expected total so the consistency job
    // never treats them as drift and silently reverts them.
    const paymentTotal = agg?.computedTotal ?? 0;
    const creditAdjustments = student.creditAdjustments || 0;
    const computedTotal = parseFloat((paymentTotal + creditAdjustments).toFixed(7));
    const computedRemaining = Math.max(0, student.feeAmount - computedTotal);

    const totalDrift = Math.abs(computedTotal - (student.totalPaid || 0));
    const remainingDrift = Math.abs(computedRemaining - (student.remainingBalance || 0));

    if (totalDrift > 0.0000001 || remainingDrift > 0.0000001) {
      mismatches.push({
        type: 'student_balance_drift',
        schoolId,
        studentId: student.studentId,
        storedTotal: student.totalPaid || 0,
        computedTotal,
        storedRemaining: student.remainingBalance || 0,
        computedRemaining,
        diff: computedTotal - (student.totalPaid || 0),
        message: `Student ${student.studentId} balance drift detected and repaired`,
      });

      await Student.findOneAndUpdate(
        { schoolId, studentId: student.studentId },
        {
          totalPaid: computedTotal,
          remainingBalance: computedRemaining,
          feePaid: computedTotal >= student.feeAmount,
        }
      );
    }
  }

  return mismatches;
}

async function checkConsistency() {
  const schools = await School.find({ isActive: true }).lean();

  // Use Promise.allSettled so a transient Horizon error for one school does not
  // abort the entire consistency cycle — every other school's check still runs
  // and records its results normally.
  const settled = await Promise.allSettled(
    schools.map((school) =>
      checkSchoolConsistency({
        schoolId: school.schoolId,
        stellarAddress: school.stellarAddress,
      })
    )
  );

  const schoolResults = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      schoolResults.push(outcome.value);
    } else {
      // Log the per-school failure so operators know which tenant is affected,
      // but don't let it silence the results from healthy schools.
      const schoolId = schools[i]?.schoolId ?? `index-${i}`;
      console.error(
        `[consistencyService] checkSchoolConsistency failed for school ${schoolId}:`,
        outcome.reason
      );
      schoolResults.push({
        schoolId,
        error: outcome.reason?.message ?? String(outcome.reason),
        totalDbPayments: 0,
        totalChainTxsScanned: 0,
        mismatchCount: 0,
        mismatches: [],
      });
    }
  }

  const totalDbPayments = schoolResults.reduce((s, r) => s + r.totalDbPayments, 0);
  const totalChainTxsScanned = schoolResults.reduce((s, r) => s + r.totalChainTxsScanned, 0);
  const allMismatches = schoolResults.flatMap((r) => r.mismatches);

  return {
    checkedAt: new Date().toISOString(),
    schoolsChecked: schools.length,
    totalDbPayments,
    totalChainTxsScanned,
    mismatchCount: allMismatches.length,
    mismatches: allMismatches,
    bySchool: schoolResults,
  };
}

module.exports = {
  checkConsistency,
  checkSchoolConsistency,
  checkStudentBalanceConsistency,
  fetchChainTransactions,
};
