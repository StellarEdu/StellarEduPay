'use strict';

/**
 * paymentModel pre-save hook status-transition validation.
 *
 * Covers:
 *   1. SUCCESS → DISPUTED is allowed (normal transition).
 *   2. FAILED  → SUCCESS is rejected with INVALID_TRANSITION.
 *   3. PENDING → FAILED  is allowed.
 *   4. SUBMITTED → FAILED is allowed.
 *   5. New documents bypass the transition check.
 *   6. No-op save (status unchanged) is allowed.
 *   7. DISPUTED → REFUNDED is rejected without admin override.
 *   8. DISPUTED → REFUNDED is allowed with $locals.adminOverride = true.
 *   9. SUCCESS → FAILED is rejected.
 *  10. DISPUTED → PENDING is rejected.
 */

// Use global so it's accessible from the hoisted jest.mock factory
global.__preSaveHook = null;

jest.mock('../backend/src/plugins/tenantScope', () => jest.fn());
jest.mock('../backend/src/services/paymentConfirmationStateMachine', () => ({
  CONFIRMATION_STATES: {
    DETECTED: 'detected', PENDING: 'pending', CONFIRMED: 'confirmed',
    FINALIZED: 'finalized', FAILED: 'failed',
  },
  CONFIRMATION_STATE_TRANSITIONS: {
    detected:  ['pending', 'failed'],
    pending:   ['confirmed', 'failed'],
    confirmed: ['finalized', 'failed'],
    finalized: [],
    failed:    [],
  },
}));

// Shared factory (mock-prefixed so babel-jest allows referencing it from the
// hoisted jest.mock calls). paymentModel resolves the DUPLICATE
// backend/node_modules/mongoose copy, so BOTH the root and backend copies must be
// mocked identically — otherwise the real backend mongoose is used and the pre-save
// hook is never captured (global.__preSaveHook stays null).
const mockMongooseFactory = () => {
  class MockSchema {
    constructor() {
      this.index   = jest.fn().mockReturnThis();
      this.virtual = jest.fn().mockReturnValue({ get: jest.fn() });
      this.plugin  = jest.fn().mockReturnThis();
      this.pre  = jest.fn((event, fn) => {
        if (event === 'save') global.__preSaveHook = fn;
      });
      this.post = jest.fn();
    }
  }
  MockSchema.Types = { Mixed: {} };
  return {
    Schema: MockSchema,
    model: jest.fn().mockReturnValue({}),
  };
};
jest.mock('mongoose', () => mockMongooseFactory());
jest.mock('../backend/node_modules/mongoose', () => mockMongooseFactory());
jest.mock('../backend/src/utils/softDelete', () => jest.fn());
jest.mock('../backend/src/utils/memoEncryption', () => ({
  encryptMemo: jest.fn(v => v),
  decryptMemo: jest.fn(v => v),
}));

beforeAll(() => {
  jest.resetModules();
  require('../backend/src/models/paymentModel');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Mongoose-like document for the pre-save hook.
 *
 * @param {string|null} originalStatus - Status stored in DB (null for new docs)
 * @param {string}      newStatus      - Current (possibly modified) status
 * @param {boolean}     isNew          - Whether this is an insert
 * @param {boolean}     adminOverride  - Set $locals.adminOverride = true
 */
function makeDoc({ originalStatus, newStatus, isNew = false, adminOverride = false }) {
  return {
    isNew,
    status: newStatus,
    memo: null,
    $locals: adminOverride ? { adminOverride: true } : {},
    isModified: jest.fn((field) => field === 'status' && originalStatus !== newStatus),
    $__: originalStatus !== null ? { savedState: { status: originalStatus } } : null,
  };
}

// The pre-save hook is a modern async function (no `next` callback) — Mongoose
// awaits the returned promise. Invoke it and surface its resolution/rejection.
function callHook(doc) {
  return global.__preSaveHook.call(doc);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('pre-save hook is registered', () => {
  expect(global.__preSaveHook).toBeInstanceOf(Function);
});

// 1. SUCCESS → DISPUTED (normal allowed transition)
test('SUCCESS → DISPUTED is allowed via save()', async () => {
  const doc = makeDoc({ originalStatus: 'SUCCESS', newStatus: 'DISPUTED' });
  await expect(callHook(doc)).resolves.toBeUndefined();
});

// 2. FAILED → SUCCESS (disallowed)
test('FAILED → SUCCESS is rejected with code INVALID_TRANSITION', async () => {
  const doc = makeDoc({ originalStatus: 'FAILED', newStatus: 'SUCCESS' });
  await expect(callHook(doc)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
});

// 3. PENDING → FAILED
test('PENDING → FAILED is allowed via save()', async () => {
  const doc = makeDoc({ originalStatus: 'PENDING', newStatus: 'FAILED' });
  await expect(callHook(doc)).resolves.toBeUndefined();
});

// 4. SUBMITTED → FAILED
test('SUBMITTED → FAILED is allowed via save()', async () => {
  const doc = makeDoc({ originalStatus: 'SUBMITTED', newStatus: 'FAILED' });
  await expect(callHook(doc)).resolves.toBeUndefined();
});

// 5. New document bypasses transition check
test('new document is allowed through without transition check', async () => {
  const doc = makeDoc({ originalStatus: null, newStatus: 'PENDING', isNew: true });
  await expect(callHook(doc)).resolves.toBeUndefined();
});

// 6. No-op save (status unchanged)
test('no-op save (status unchanged) is allowed', async () => {
  const doc = makeDoc({ originalStatus: 'SUCCESS', newStatus: 'SUCCESS' });
  await expect(callHook(doc)).resolves.toBeUndefined();
});

// 7. SUCCESS → FAILED is rejected
test('SUCCESS → FAILED is rejected with code INVALID_TRANSITION', async () => {
  const doc = makeDoc({ originalStatus: 'SUCCESS', newStatus: 'FAILED' });
  await expect(callHook(doc)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
});

// 8. DISPUTED → PENDING is rejected
test('DISPUTED → PENDING is rejected with code INVALID_TRANSITION', async () => {
  const doc = makeDoc({ originalStatus: 'DISPUTED', newStatus: 'PENDING' });
  await expect(callHook(doc)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
});

// 9. DISPUTED → REFUNDED: blocked without admin override
test('DISPUTED → REFUNDED is rejected without admin override', async () => {
  const doc = makeDoc({ originalStatus: 'DISPUTED', newStatus: 'REFUNDED' });
  await expect(callHook(doc)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
});

// 10. DISPUTED → REFUNDED: allowed with $locals.adminOverride = true
test('DISPUTED → REFUNDED is allowed with $locals.adminOverride = true', async () => {
  const doc = makeDoc({ originalStatus: 'DISPUTED', newStatus: 'REFUNDED', adminOverride: true });
  await expect(callHook(doc)).resolves.toBeUndefined();
});

// 11. SUCCESS → DISPUTED: allowed with admin override (same result as without)
test('SUCCESS → DISPUTED is also allowed with admin override', async () => {
  const doc = makeDoc({ originalStatus: 'SUCCESS', newStatus: 'DISPUTED', adminOverride: true });
  await expect(callHook(doc)).resolves.toBeUndefined();
});
