'use strict';

const { server } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');

/**
 * Fetch up to 200 transactions for a given wallet address from Horizon.
 * @param {string} walletAddress
 */
async function fetchChainTransactions(walletAddress) {
  const result = await server.transactions()
    .forAccount(walletAddress)
    .order('desc')
    .limit(200)
    .call();
  return result.records;
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

    const computedTotal = agg?.computedTotal ?? 0;
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

  const schoolResults = await Promise.all(
    schools.map((school) =>
      checkSchoolConsistency({
        schoolId: school.schoolId,
        stellarAddress: school.stellarAddress,
      })
    )
  );

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
  fetchChainTransactions,
};
