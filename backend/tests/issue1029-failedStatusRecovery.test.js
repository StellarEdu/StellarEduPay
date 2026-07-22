'use strict';

/**
 * Tests for Issue #1029 — FAILED status has no outgoing transitions.
 *
 * Acceptance criteria:
 *   1. An admin (adminOverride = true) can transition a FAILED payment to a
 *      corrected terminal state (SUCCESS or DISPUTED).
 *   2. A non-admin path (adminOverride = false, the pre-save default) still
 *      cannot move a payment out of FAILED — the dead end remains for
 *      unprivileged callers.
 *   3. Transitions out of FAILED that were never requested (e.g. straight to
 *      REFUNDED, or back to PENDING) stay rejected even under admin override.
 */

const {
  PAYMENT_STATUS,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  isTransitionAllowed,
} = require('../src/constants/paymentStatus');

describe('Issue #1029 — paymentStatus transition tables', () => {
  it('does NOT allow any transition out of FAILED in the normal (non-admin) table', () => {
    expect(PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.FAILED]).toBeUndefined();
  });

  it('allows FAILED -> SUCCESS and FAILED -> DISPUTED in the admin table', () => {
    expect(ADMIN_PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.FAILED]).toEqual(
      expect.arrayContaining([PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.DISPUTED]),
    );
  });

  it('does not open up FAILED -> REFUNDED or FAILED -> PENDING', () => {
    const allowed = ADMIN_PAYMENT_STATUS_TRANSITIONS[PAYMENT_STATUS.FAILED];
    expect(allowed).not.toContain(PAYMENT_STATUS.REFUNDED);
    expect(allowed).not.toContain(PAYMENT_STATUS.PENDING);
  });

  describe('isTransitionAllowed', () => {
    it('rejects FAILED -> SUCCESS without admin override', () => {
      expect(isTransitionAllowed(PAYMENT_STATUS.FAILED, PAYMENT_STATUS.SUCCESS, false)).toBe(false);
    });

    it('allows FAILED -> SUCCESS with admin override', () => {
      expect(isTransitionAllowed(PAYMENT_STATUS.FAILED, PAYMENT_STATUS.SUCCESS, true)).toBe(true);
    });

    it('allows FAILED -> DISPUTED with admin override', () => {
      expect(isTransitionAllowed(PAYMENT_STATUS.FAILED, PAYMENT_STATUS.DISPUTED, true)).toBe(true);
    });

    it('rejects FAILED -> REFUNDED even with admin override', () => {
      expect(isTransitionAllowed(PAYMENT_STATUS.FAILED, PAYMENT_STATUS.REFUNDED, true)).toBe(false);
    });
  });
});

// ── Model-level enforcement ──────────────────────────────────────────────────
// The pre-save hook (paymentModel.js) is what actually enforces the tables
// above at persistence time. Exercise it directly, the same way
// paymentModelValidation.test.js does, without needing a live database.

jest.mock('../src/utils/softDelete', () => (schema) => schema);
jest.mock('../src/utils/memoEncryption', () => ({
  encryptMemo: (v) => v,
  decryptMemo: (v) => v,
}));
jest.mock('../src/plugins/tenantScope', () => () => {});
jest.mock('../src/services/paymentConfirmationStateMachine', () => ({
  CONFIRMATION_STATES: {
    DETECTED: 'detected', PENDING: 'pending', CONFIRMED: 'confirmed', FINALIZED: 'finalized', FAILED: 'failed',
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

let Payment;
beforeAll(() => {
  jest.isolateModules(() => {
    Payment = require('../src/models/paymentModel');
  });
});

function makePayment(overrides = {}) {
  return new Payment({
    schoolId: 'school-1',
    studentId: 'STU001',
    txHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    amount: 100,
    assetCode: 'XLM',
    feeAmount: 100,
    excessAmount: 0,
    confirmationState: 'failed',
    ...overrides,
  });
}

// Simulate an already-persisted document sitting at FAILED, then reassign
// status in memory the way a controller would before calling save().
function simulatePersistedFailedPayment(nextStatus) {
  const doc = makePayment({ status: PAYMENT_STATUS.FAILED });
  doc.$__.savedState = { status: PAYMENT_STATUS.FAILED, confirmationState: 'failed' };
  doc.isNew = false;
  doc.status = nextStatus;
  return doc;
}

function runPreSaveHook(doc) {
  return new Promise((resolve, reject) => {
    doc.schema.s.hooks.execPre('save', doc, [], (err) => (err ? reject(err) : resolve()));
  });
}

describe('Issue #1029 — Payment pre-save transition guard for FAILED', () => {
  it('rejects FAILED -> SUCCESS when $locals.adminOverride is not set (non-admin path)', async () => {
    const doc = simulatePersistedFailedPayment(PAYMENT_STATUS.SUCCESS);
    await expect(runPreSaveHook(doc)).rejects.toThrow(/not allowed/);
  });

  it('allows FAILED -> SUCCESS when $locals.adminOverride = true', async () => {
    const doc = simulatePersistedFailedPayment(PAYMENT_STATUS.SUCCESS);
    doc.$locals.adminOverride = true;
    await expect(runPreSaveHook(doc)).resolves.toBeUndefined();
  });

  it('allows FAILED -> DISPUTED when $locals.adminOverride = true', async () => {
    const doc = simulatePersistedFailedPayment(PAYMENT_STATUS.DISPUTED);
    doc.$locals.adminOverride = true;
    await expect(runPreSaveHook(doc)).resolves.toBeUndefined();
  });

  it('still rejects FAILED -> REFUNDED even with admin override (not a suggested/allowed path)', async () => {
    const doc = simulatePersistedFailedPayment(PAYMENT_STATUS.REFUNDED);
    doc.$locals.adminOverride = true;
    await expect(runPreSaveHook(doc)).rejects.toThrow(/not allowed/);
  });
});
