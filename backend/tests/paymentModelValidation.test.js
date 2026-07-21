'use strict';

/**
 * Issue #68 — Payment schema validation tests
 *
 * Acceptance criteria:
 *   1. Invalid amounts/assets rejected at the model layer.
 *   2. Precision normalized consistently (7 decimal places).
 *   3. Aggregates never see NaN/negatives (validators block them at save time).
 *
 * Mongoose is mocked to avoid a real database connection; we interact with
 * model instances directly to exercise the pre-save hook and validators.
 */

// ── Minimal mongoose mock ────────────────────────────────────────────────────
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return actual;
});

// ── Service/util stubs the model imports ────────────────────────────────────
jest.mock('../src/utils/softDelete', () => (schema) => schema);
jest.mock('../src/utils/memoEncryption', () => ({
  encryptMemo: (v) => v,
  decryptMemo: (v) => v,
}));
jest.mock('../src/plugins/tenantScope', () =>
  // tenantScope is used as: paymentSchema.plugin(tenantScope, { modelName: 'Payment' })
  // Mongoose schema.plugin() requires its first argument to be a function.
  () => {},
);
jest.mock('../src/services/paymentConfirmationStateMachine', () => ({
  CONFIRMATION_STATES: {
    DETECTED: 'detected',
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    FINALIZED: 'finalized',
    FAILED: 'failed',
  },
  CONFIRMATION_STATE_TRANSITIONS: {
    detected: ['pending', 'failed'],
    pending: ['confirmed', 'failed'],
    confirmed: ['finalized', 'failed'],
    finalized: [],
    failed: [],
  },
  isConfirmedOrAbove: (s) => ['confirmed', 'finalized'].includes(s),
  deriveLegacyConfirmationStatus: (s) =>
    ['confirmed', 'finalized'].includes(s) ? 'confirmed' : s === 'failed' ? 'failed' : 'pending_confirmation',
}));

// ── Load Payment model ───────────────────────────────────────────────────────
const mongoose = require('mongoose');

let Payment;
beforeAll(() => {
  // We only need the schema logic, not a real DB.  Requiring the model after
  // mocks are in place gives us a fully-wired Mongoose document.
  jest.isolateModules(() => {
    Payment = require('../src/models/paymentModel');
  });
});

// Helper: build a valid base payment document
function makePayment(overrides = {}) {
  return new Payment({
    schoolId: 'school-1',
    studentId: 'STU001',
    txHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    amount: 100,
    assetCode: 'XLM',
    feeAmount: 100,
    excessAmount: 0,
    ...overrides,
  });
}

// Run only the validators (no DB I/O required)
async function validate(doc) {
  return doc.validate();
}

// ── amount ───────────────────────────────────────────────────────────────────
describe('Payment schema — amount', () => {
  it('accepts a valid positive amount', async () => {
    await expect(validate(makePayment({ amount: 50 }))).resolves.toBeUndefined();
  });

  it('accepts amount = 0 (boundary)', async () => {
    await expect(validate(makePayment({ amount: 0 }))).resolves.toBeUndefined();
  });

  it('rejects a negative amount', async () => {
    await expect(validate(makePayment({ amount: -1 }))).rejects.toThrow(/non-negative/);
  });

  it('rejects NaN amount', async () => {
    await expect(validate(makePayment({ amount: NaN }))).rejects.toThrow();
  });

  it('rejects Infinity amount', async () => {
    // Mongoose casts Infinity to null/undefined — the required validator fires
    const doc = makePayment({});
    doc.amount = Infinity;
    await expect(validate(doc)).rejects.toThrow();
  });

  it('rejects missing amount (required)', async () => {
    const doc = makePayment({});
    doc.amount = undefined;
    await expect(validate(doc)).rejects.toThrow();
  });
});

// ── feeAmount ────────────────────────────────────────────────────────────────
describe('Payment schema — feeAmount', () => {
  it('accepts null feeAmount (not yet resolved)', async () => {
    await expect(validate(makePayment({ feeAmount: null }))).resolves.toBeUndefined();
  });

  it('accepts a valid positive feeAmount', async () => {
    await expect(validate(makePayment({ feeAmount: 200 }))).resolves.toBeUndefined();
  });

  it('accepts feeAmount = 0', async () => {
    await expect(validate(makePayment({ feeAmount: 0 }))).resolves.toBeUndefined();
  });

  it('rejects a negative feeAmount', async () => {
    await expect(validate(makePayment({ feeAmount: -0.01 }))).rejects.toThrow(/non-negative/);
  });
});

// ── excessAmount ─────────────────────────────────────────────────────────────
describe('Payment schema — excessAmount', () => {
  it('accepts 0 excessAmount (default)', async () => {
    await expect(validate(makePayment({ excessAmount: 0 }))).resolves.toBeUndefined();
  });

  it('accepts a positive excessAmount', async () => {
    await expect(validate(makePayment({ excessAmount: 10.5 }))).resolves.toBeUndefined();
  });

  it('rejects a negative excessAmount', async () => {
    await expect(validate(makePayment({ excessAmount: -1 }))).rejects.toThrow(/non-negative/);
  });
});

// ── assetCode ────────────────────────────────────────────────────────────────
describe('Payment schema — assetCode enum', () => {
  it('accepts XLM', async () => {
    await expect(validate(makePayment({ assetCode: 'XLM' }))).resolves.toBeUndefined();
  });

  it('accepts USDC', async () => {
    await expect(validate(makePayment({ assetCode: 'USDC' }))).resolves.toBeUndefined();
  });

  it('accepts null (default — asset not yet determined)', async () => {
    await expect(validate(makePayment({ assetCode: null }))).resolves.toBeUndefined();
  });

  it('rejects unknown asset code (e.g. BTC)', async () => {
    await expect(validate(makePayment({ assetCode: 'BTC' }))).rejects.toThrow(/assetCode/);
  });

  it('rejects empty string as asset code', async () => {
    await expect(validate(makePayment({ assetCode: '' }))).rejects.toThrow(/assetCode/);
  });
});

// ── Precision normalization pre-save hook ─────────────────────────────────────
describe('Payment schema — precision normalization (pre-save hook)', () => {
  /**
   * Invoke the pre-save hooks registered on the schema.
   * kareem's execPre(name, context, args, callback) treats a 3-argument call
   * as (name, context, callback) — so we must pass an explicit args array AND
   * a callback. We wrap it in a Promise so the async normalization hook is
   * actually awaited before we assert.
   */
  function runPreSaveHook(doc) {
    return new Promise((resolve, reject) => {
      doc.schema.s.hooks.execPre('save', doc, [], (err) => (err ? reject(err) : resolve()));
    });
  }

  it('normalizes amount to 7 decimal places', async () => {
    const doc = makePayment({ amount: 100.123456789 });
    await runPreSaveHook(doc);
    expect(doc.amount).toBe(100.1234568); // rounded to 7dp
  });

  it('normalizes feeAmount to 7 decimal places', async () => {
    const doc = makePayment({ feeAmount: 50.0000001234 });
    doc.$__.savedState = null; // new doc shortcut for status-transition guard
    await runPreSaveHook(doc);
    expect(doc.feeAmount).toBe(50.0000001);
  });

  it('normalizes excessAmount to 7 decimal places', async () => {
    const doc = makePayment({ excessAmount: 0.0000002 });
    await runPreSaveHook(doc);
    expect(doc.excessAmount).toBe(0.0000002);
  });

  it('leaves null feeAmount untouched', async () => {
    const doc = makePayment({ feeAmount: null });
    await runPreSaveHook(doc);
    expect(doc.feeAmount).toBeNull();
  });

  it('leaves a whole-number amount unchanged', async () => {
    const doc = makePayment({ amount: 250 });
    await runPreSaveHook(doc);
    expect(doc.amount).toBe(250);
  });

  it('normalizes a very small amount correctly', async () => {
    const doc = makePayment({ amount: 0.00000001 });
    await runPreSaveHook(doc);
    expect(doc.amount).toBe(0); // rounds to 0 at 7dp
  });

  it('handles the minimum valid amount (0.0000001)', async () => {
    const doc = makePayment({ amount: 0.0000001 });
    await runPreSaveHook(doc);
    expect(doc.amount).toBe(0.0000001);
  });
});

// ── Aggregate safety ─────────────────────────────────────────────────────────
describe('Payment schema — aggregate safety', () => {
  it('rejects NaN before it can reach an aggregate', async () => {
    const doc = makePayment({ amount: NaN });
    await expect(validate(doc)).rejects.toThrow();
  });

  it('rejects negative feeAmount before it can reach an aggregate', async () => {
    const doc = makePayment({ feeAmount: -100 });
    await expect(validate(doc)).rejects.toThrow(/non-negative/);
  });

  it('rejects negative excessAmount before it can reach an aggregate', async () => {
    const doc = makePayment({ excessAmount: -0.5 });
    await expect(validate(doc)).rejects.toThrow(/non-negative/);
  });
});
