'use strict';

/**
 * Property-based test for fix #1751 — Unified student balance computation.
 *
 * Verifies that for any random sequence of payment events (poller, verify, sync,
 * finalize, credit, dispute, refund) the stored Student balance always equals the
 * canonical formula:
 *
 *   totalPaid = Σ amount  where  status === 'SUCCESS'
 *                                AND isSuspicious === false
 *                                AND deletedAt === null
 *               + creditAdjustments
 *
 * The test runs N random event sequences.  After applying all events it calls
 * updateStudentBalance (the canonical writer) and checks that the result equals
 * the same formula computed directly from the in-memory payment list.
 *
 * This test mocks all DB calls so it can run without MongoDB.
 */

// ── Logger ────────────────────────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── In-memory store shared by model mocks ─────────────────────────────────────
// Populated fresh for every test case by buildStore().
let store = null;

// ── Student model mock ────────────────────────────────────────────────────────
jest.mock('../src/models/studentModel', () => {
  const findOne = jest.fn(({ schoolId, studentId }) => {
    const student = store ? store.students.find(
      s => s.schoolId === schoolId && s.studentId === studentId
    ) : null;
    // Mongoose-like: returns an object with .session() chainable method
    const result = student ? { ...student } : null;
    return {
      // session() is called with a session argument, we ignore it and return self
      session: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
  });

  const findOneAndUpdate = jest.fn((filter, update, opts) => {
    if (!store) return Promise.resolve(null);
    const idx = store.students.findIndex(
      s => s.schoolId === filter.schoolId && s.studentId === filter.studentId
    );
    if (idx === -1) return Promise.resolve(null);
    Object.assign(store.students[idx], update);
    const result = { ...store.students[idx] };
    return {
      session: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
  });

  return { findOne, findOneAndUpdate };
});

// ── Payment model mock ─────────────────────────────────────────────────────────
jest.mock('../src/models/paymentModel', () => {
  // aggregate() needs to handle two patterns:
  //   1. Total payments: { status:'SUCCESS', isSuspicious:false, deletedAt:null }
  //   2. Per-category:   same + feeCategory filter
  const aggregate = jest.fn((pipeline) => {
    if (!store) return { session: () => Promise.resolve([]) };
    const match = (pipeline[0] && pipeline[0].$match) || {};

    const results = store.payments.filter(p => {
      if (match.schoolId !== undefined && p.schoolId !== match.schoolId) return false;
      if (match.studentId !== undefined && p.studentId !== match.studentId) return false;
      if (match.status !== undefined && p.status !== match.status) return false;
      if (match.isSuspicious !== undefined && p.isSuspicious !== match.isSuspicious) return false;
      if (match.deletedAt !== undefined && p.deletedAt !== match.deletedAt) return false;
      if (match.feeCategory !== undefined && p.feeCategory !== match.feeCategory) return false;
      return true;
    });

    const total = results.reduce((sum, p) => sum + p.amount, 0);
    const grouped = results.length > 0 ? [{ _id: null, total: { toNumber: () => total, _bsontype: 'Decimal128' } }] : [];

    return {
      session: () => Promise.resolve(grouped),
      then: (resolve, reject) => Promise.resolve(grouped).then(resolve, reject),
    };
  });

  return { aggregate };
});

// ── money.js mock — thin wrapper so decimalFromMongo works with our fake Decimal ──
jest.mock('../src/utils/money', () => {
  // Minimal BigDecimal-like wrapper
  class Money {
    constructor(n) { this._n = Number(n) || 0; }
    plus(other) { return new Money(this._n + other._n); }
    toNumber()  { return this._n; }
    valueOf()   { return this._n; }
  }

  return {
    toMoney:        (n) => new Money(n),
    decimalFromMongo: (d) => {
      // Our fake Decimal128 has a toNumber() method
      return new Money(typeof d.toNumber === 'function' ? d.toNumber() : Number(d));
    },
    classifyFeePayment: (cumulativeTotal, feeAmount) => {
      const total  = typeof cumulativeTotal.toNumber === 'function'
        ? cumulativeTotal.toNumber() : Number(cumulativeTotal);
      const fee    = Number(feeAmount);
      const remaining = Math.max(0, fee - total);
      let status;
      if (total < fee)      status = 'partial';
      else if (total > fee) status = 'overpaid';
      else                  status = 'valid';
      return {
        cumulativeTotal:  total,
        remainingBalance: remaining,
        excessAmount:     total > fee ? total - fee : 0,
        feePaid:          total >= fee,
        status,
      };
    },
  };
});

// ── Now we can safely import the unit under test ───────────────────────────────
const { updateStudentBalance } = require('../src/utils/studentBalanceUpdater');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SCHOOL_ID  = 'SCHOOL-TEST';
const STUDENT_ID = 'STU-001';
const FEE_AMOUNT = 300;

/** Seedable PRNG (xorshift32) so failing seeds are reproducible. */
function makePrng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randChoice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Build a fresh in-memory store with one student.
 */
function buildStore(creditAdjustments = 0) {
  return {
    students: [{
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      feeAmount: FEE_AMOUNT,
      creditAdjustments,
      totalPaid: 0,
      remainingBalance: FEE_AMOUNT,
      feePaid: false,
      fees: [],
    }],
    payments: [],
  };
}

/**
 * Generate a random list of payment events and apply them to store.payments.
 * Returns the resulting store.
 *
 * Event types:
 *   'poller'   — payment arrives via poller (SUCCESS, not suspicious)
 *   'verify'   — manual verify (SUCCESS, not suspicious)
 *   'sync'     — syncPaymentsForSchool (SUCCESS, not suspicious)
 *   'failed'   — payment records as FAILED
 *   'pending'  — payment stays PENDING
 *   'suspicious' — SUCCESS but isSuspicious=true
 *   'refunded' — status becomes REFUNDED (via a status mutation)
 *   'deleted'  — soft-delete a previously recorded payment
 *   'credit'   — admin credit adjustment (modifies student.creditAdjustments)
 *   'disputed' — SUCCESS, not suspicious, but separate status (treated like SUCCESS)
 */
function applyRandomEvents(rng, store) {
  const eventCount = randInt(rng, 1, 20);
  const eventTypes = ['poller', 'verify', 'sync', 'failed', 'pending',
                      'suspicious', 'refunded', 'deleted', 'credit'];

  for (let i = 0; i < eventCount; i++) {
    const type   = randChoice(rng, eventTypes);
    const amount = parseFloat((rng() * 200 + 10).toFixed(7));
    const txHash = `tx${i}-${Math.floor(rng() * 1e9)}`;

    switch (type) {
      case 'poller':
      case 'verify':
      case 'sync': {
        store.payments.push({
          schoolId:    SCHOOL_ID,
          studentId:   STUDENT_ID,
          txHash,
          amount,
          status:      'SUCCESS',
          isSuspicious: false,
          deletedAt:   null,
        });
        break;
      }
      case 'failed': {
        store.payments.push({
          schoolId:    SCHOOL_ID,
          studentId:   STUDENT_ID,
          txHash,
          amount,
          status:      'FAILED',
          isSuspicious: false,
          deletedAt:   null,
        });
        break;
      }
      case 'pending': {
        store.payments.push({
          schoolId:    SCHOOL_ID,
          studentId:   STUDENT_ID,
          txHash,
          amount,
          status:      'PENDING',
          isSuspicious: false,
          deletedAt:   null,
        });
        break;
      }
      case 'suspicious': {
        store.payments.push({
          schoolId:    SCHOOL_ID,
          studentId:   STUDENT_ID,
          txHash,
          amount,
          status:      'SUCCESS',
          isSuspicious: true,
          deletedAt:   null,
        });
        break;
      }
      case 'refunded': {
        // Record as SUCCESS then simulate refund by changing status
        const p = {
          schoolId:    SCHOOL_ID,
          studentId:   STUDENT_ID,
          txHash,
          amount,
          status:      'REFUNDED',
          isSuspicious: false,
          deletedAt:   null,
        };
        store.payments.push(p);
        break;
      }
      case 'deleted': {
        // Soft-delete a random existing payment
        const candidates = store.payments.filter(
          p => p.deletedAt === null && p.schoolId === SCHOOL_ID
        );
        if (candidates.length > 0) {
          const target = randChoice(rng, candidates);
          target.deletedAt = new Date();
        }
        break;
      }
      case 'credit': {
        // Admin credit adjustment
        const creditAmount = parseFloat((rng() * 50).toFixed(7));
        const student = store.students.find(
          s => s.schoolId === SCHOOL_ID && s.studentId === STUDENT_ID
        );
        if (student) {
          student.creditAdjustments = (student.creditAdjustments || 0) + creditAmount;
        }
        break;
      }
    }
  }

  return store;
}

/**
 * Compute the expected balance directly from the in-memory store using the
 * canonical formula — used as the oracle to check updateStudentBalance against.
 */
function computeExpectedBalance(store) {
  const student = store.students.find(
    s => s.schoolId === SCHOOL_ID && s.studentId === STUDENT_ID
  );
  const creditAdjustments = student ? (student.creditAdjustments || 0) : 0;

  const paymentTotal = store.payments
    .filter(p =>
      p.schoolId    === SCHOOL_ID &&
      p.studentId   === STUDENT_ID &&
      p.status      === 'SUCCESS' &&
      p.isSuspicious === false &&
      p.deletedAt   === null
    )
    .reduce((sum, p) => sum + p.amount, 0);

  const totalPaid       = parseFloat((paymentTotal + creditAdjustments).toFixed(10));
  const remainingBalance = Math.max(0, parseFloat((FEE_AMOUNT - totalPaid).toFixed(10)));
  const feePaid          = totalPaid >= FEE_AMOUNT;

  return { totalPaid, remainingBalance, feePaid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('updateStudentBalance — property-based (fix #1751)', () => {
  /**
   * Runs a single property-based scenario with the given PRNG seed.
   * Returns the failing assertion info or null on success.
   */
  async function runScenario(seed) {
    store = buildStore(0);
    const rng = makePrng(seed);
    applyRandomEvents(rng, store);

    // Run the canonical writer
    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    if (!updated) return { seed, reason: 'updateStudentBalance returned null' };

    const expected = computeExpectedBalance(store);

    const tol = 1e-6; // floating-point tolerance

    if (Math.abs(updated.totalPaid - expected.totalPaid) > tol) {
      return {
        seed,
        reason: `totalPaid mismatch: got ${updated.totalPaid}, expected ${expected.totalPaid}`,
        store: JSON.stringify(store.payments, null, 2),
      };
    }

    if (Math.abs(updated.remainingBalance - expected.remainingBalance) > tol) {
      return {
        seed,
        reason: `remainingBalance mismatch: got ${updated.remainingBalance}, expected ${expected.remainingBalance}`,
      };
    }

    if (updated.feePaid !== expected.feePaid) {
      return {
        seed,
        reason: `feePaid mismatch: got ${updated.feePaid}, expected ${expected.feePaid}`,
      };
    }

    return null; // pass
  }

  test('stored balance equals canonical formula for 100 random event sequences', async () => {
    const SEEDS = 100;
    const failures = [];

    for (let seed = 1; seed <= SEEDS; seed++) {
      const failure = await runScenario(seed);
      if (failure) failures.push(failure);
    }

    if (failures.length > 0) {
      const report = failures
        .slice(0, 5) // show first 5 failures
        .map(f => `  seed=${f.seed}: ${f.reason}`)
        .join('\n');
      throw new Error(
        `updateStudentBalance diverged from canonical formula in ${failures.length}/${SEEDS} scenarios:\n${report}`
      );
    }
  }, 30000); // 30s timeout for 100 scenarios

  test('suspicious payments are excluded regardless of event order', async () => {
    store = buildStore(0);
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 100, status: 'SUCCESS', isSuspicious: true,  deletedAt: null },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx2', amount: 50,  status: 'SUCCESS', isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(50, 6);
    expect(updated.remainingBalance).toBeCloseTo(250, 6);
    expect(updated.feePaid).toBe(false);
  });

  test('FAILED and PENDING payments are excluded', async () => {
    store = buildStore(0);
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 100, status: 'FAILED',  isSuspicious: false, deletedAt: null },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx2', amount: 80,  status: 'PENDING', isSuspicious: false, deletedAt: null },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx3', amount: 120, status: 'SUCCESS', isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(120, 6);
    expect(updated.remainingBalance).toBeCloseTo(180, 6);
  });

  test('REFUNDED payments (status:REFUNDED) are excluded', async () => {
    store = buildStore(0);
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 200, status: 'REFUNDED', isSuspicious: false, deletedAt: null },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx2', amount: 100, status: 'SUCCESS',  isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(100, 6);
    expect(updated.remainingBalance).toBeCloseTo(200, 6);
    expect(updated.feePaid).toBe(false);
  });

  test('soft-deleted payments are excluded', async () => {
    const deletedAt = new Date();
    store = buildStore(0);
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 150, status: 'SUCCESS', isSuspicious: false, deletedAt },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx2', amount: 75,  status: 'SUCCESS', isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(75, 6);
    expect(updated.feePaid).toBe(false);
  });

  test('creditAdjustments are included in totalPaid', async () => {
    store = buildStore(50); // 50 credit pre-applied
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 200, status: 'SUCCESS', isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    // 200 (payment) + 50 (credit) = 250 paid; remaining = 50
    expect(updated.totalPaid).toBeCloseTo(250, 6);
    expect(updated.remainingBalance).toBeCloseTo(50, 6);
    expect(updated.feePaid).toBe(false);
  });

  test('creditAdjustments alone can make feePaid:true', async () => {
    store = buildStore(300); // full credit
    // no on-chain payments

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(300, 6);
    expect(updated.remainingBalance).toBeCloseTo(0, 6);
    expect(updated.feePaid).toBe(true);
  });

  test('exact installment sum reaching fee marks feePaid:true', async () => {
    store = buildStore(0);
    // Three installments summing exactly to 300
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 100, status: 'SUCCESS', isSuspicious: false, deletedAt: null },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx2', amount: 100, status: 'SUCCESS', isSuspicious: false, deletedAt: null },
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx3', amount: 100, status: 'SUCCESS', isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(300, 6);
    expect(updated.remainingBalance).toBeCloseTo(0, 6);
    expect(updated.feePaid).toBe(true);
  });

  test('overpayment floors remainingBalance at 0', async () => {
    store = buildStore(0);
    store.payments.push(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID, txHash: 'tx1', amount: 400, status: 'SUCCESS', isSuspicious: false, deletedAt: null },
    );

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated.totalPaid).toBeCloseTo(400, 6);
    expect(updated.remainingBalance).toBe(0);
    expect(updated.feePaid).toBe(true);
  });

  test('returns null when student does not exist', async () => {
    store = buildStore(0);
    store.students = []; // empty

    const updated = await updateStudentBalance(SCHOOL_ID, STUDENT_ID, {});
    expect(updated).toBeNull();
  });
});
