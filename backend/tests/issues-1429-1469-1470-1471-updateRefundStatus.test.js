'use strict';

/**
 * Tests for issues #1429, #1469, #1470, #1471:
 *   - updateRefundStatus must validate newStatus against the model enum
 *     (VALID_REFUND_STATUSES) before writing to the database.
 *   - updateRefundStatus must enforce the legal-transition table
 *     (REFUND_STATUS_TRANSITIONS) — out-of-order and terminal-state
 *     transitions are rejected.
 *   - updateRefundStatus must acquire the same per-payment distributed lock
 *     used by initiateRefund before entering its critical section.
 *   - The lock must be released in all exit paths, including error paths.
 *
 * The test suite mirrors the style of issue1212-refundDoubleSpendGuard.test.js
 * so the two files are easy to read together.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

// ── Model mocks ──────────────────────────────────────────────────────────────

const mockRefundFindById = jest.fn();
const mockRefundSave    = jest.fn();

jest.mock('../src/models/refundModel', () => ({
  findById: (...args) => mockRefundFindById(...args),
  findOne:  jest.fn(),
  create:   jest.fn(),
  find:     jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  }),
}));

jest.mock('../src/models/paymentModel', () => ({
  findOne: jest.fn(),
}));

const mockOutboxCreate = jest.fn().mockResolvedValue({});
jest.mock('../src/models/outboxModel', () => ({
  create: (...args) => mockOutboxCreate(...args),
}));

// ── Distributed lock mock ────────────────────────────────────────────────────

const mockLockAcquire = jest.fn();
const mockLockRelease = jest.fn().mockResolvedValue(true);

jest.mock('../src/services/distributedLock', () => ({
  acquire:         (...args) => mockLockAcquire(...args),
  release:         (...args) => mockLockRelease(...args),
  _resetLocalLocks: jest.fn(),
}));

// ── Stellar amount util ──────────────────────────────────────────────────────
jest.mock('../src/utils/stellarAmount', () => ({
  amountsEqual: (a, b) => a === b,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const REFUND_ID    = 'refund-id-999';
const SCHOOL_ID    = 'SCH-TEST';
const TX_HASH      = 'abc123txhash';
const REFUND_TX    = 'def456refundtx';

/**
 * Build a mock Refund document in the given status.
 * The save() mock is per-instance so callers can inspect or override it.
 */
function mockRefund(status = 'pending') {
  const doc = {
    _id:            REFUND_ID,
    schoolId:       SCHOOL_ID,
    originalTxHash: TX_HASH,
    status,
    refundTxHash:   null,
    confirmedAt:    null,
    failureReason:  null,
    failedAt:       null,
    save:           jest.fn().mockImplementation(async function () { return this; }),
  };
  return doc;
}

// ── Import service AFTER mocks are set up ────────────────────────────────────

const {
  updateRefundStatus,
  refundLockKey,
  VALID_REFUND_STATUSES,
  REFUND_STATUS_TRANSITIONS,
} = require('../src/services/refundService');

// ── Reset state between tests ────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: lock is available
  mockLockAcquire.mockResolvedValue({ token: 'tok-1', fencingToken: 1 });
  // Default: refund exists in 'pending' state (set per-test as needed)
  const doc = mockRefund('pending');
  mockRefundFindById.mockResolvedValue(doc);
});

// ── VALID_REFUND_STATUSES ────────────────────────────────────────────────────

describe('VALID_REFUND_STATUSES', () => {
  it('contains exactly the five enum values from the Refund model', () => {
    expect(VALID_REFUND_STATUSES.sort()).toEqual(
      ['approval_pending', 'confirmed', 'failed', 'pending', 'submitted']
    );
  });
});

// ── REFUND_STATUS_TRANSITIONS ────────────────────────────────────────────────

describe('REFUND_STATUS_TRANSITIONS', () => {
  it('has an entry for every valid status', () => {
    for (const s of VALID_REFUND_STATUSES) {
      expect(REFUND_STATUS_TRANSITIONS).toHaveProperty(s);
    }
  });

  it('approval_pending can transition to pending or failed', () => {
    expect(REFUND_STATUS_TRANSITIONS.approval_pending).toEqual(
      expect.arrayContaining(['pending', 'failed'])
    );
    expect(REFUND_STATUS_TRANSITIONS.approval_pending).toHaveLength(2);
  });

  it('pending can transition to submitted or failed', () => {
    expect(REFUND_STATUS_TRANSITIONS.pending).toEqual(
      expect.arrayContaining(['submitted', 'failed'])
    );
    expect(REFUND_STATUS_TRANSITIONS.pending).toHaveLength(2);
  });

  it('submitted can transition to confirmed or failed', () => {
    expect(REFUND_STATUS_TRANSITIONS.submitted).toEqual(
      expect.arrayContaining(['confirmed', 'failed'])
    );
    expect(REFUND_STATUS_TRANSITIONS.submitted).toHaveLength(2);
  });

  it('confirmed is terminal — no outgoing transitions', () => {
    expect(REFUND_STATUS_TRANSITIONS.confirmed).toHaveLength(0);
  });

  it('failed is terminal — no outgoing transitions', () => {
    expect(REFUND_STATUS_TRANSITIONS.failed).toHaveLength(0);
  });
});

// ── Happy paths ──────────────────────────────────────────────────────────────

describe('updateRefundStatus — happy path', () => {
  const validCases = [
    { from: 'approval_pending', to: 'pending'   },
    { from: 'approval_pending', to: 'failed'    },
    { from: 'pending',          to: 'submitted' },
    { from: 'pending',          to: 'failed'    },
    { from: 'submitted',        to: 'confirmed' },
    { from: 'submitted',        to: 'failed'    },
  ];

  for (const { from, to } of validCases) {
    it(`transitions ${from} → ${to} and persists the change`, async () => {
      const doc = mockRefund(from);
      // first call: initial fetch; second call: re-fetch inside lock
      mockRefundFindById.mockResolvedValue(doc);

      await updateRefundStatus(REFUND_ID, to);

      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(doc.status).toBe(to);
    });
  }

  it('sets refundTxHash and confirmedAt when transitioning to confirmed', async () => {
    const doc = mockRefund('submitted');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'confirmed', REFUND_TX);

    expect(doc.refundTxHash).toBe(REFUND_TX);
    expect(doc.confirmedAt).toBeInstanceOf(Date);
  });

  it('sets failureReason and failedAt when transitioning to failed', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'failed', null, 'network error');

    expect(doc.failureReason).toBe('network error');
    expect(doc.failedAt).toBeInstanceOf(Date);
  });

  it('emits a refund.status_changed outbox event on success', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'submitted');

    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'refund.status_changed',
        payload: expect.objectContaining({
          previousStatus: 'pending',
          newStatus: 'submitted',
        }),
      })
    );
  });
});

// ── Enum validation (issue #1469 / #1471) ────────────────────────────────────

describe('updateRefundStatus — invalid status enum (#1469 / #1471)', () => {
  const bogusValues = ['', 'typo_status', 'PENDING', 'Submitted', 'approved', 123, null, undefined];

  for (const bad of bogusValues) {
    it(`rejects "${bad}" before touching the database`, async () => {
      const err = await updateRefundStatus(REFUND_ID, bad).catch(e => e);

      expect(err.code).toBe('INVALID_STATUS');
      // The database must not have been touched at all
      expect(mockRefundFindById).not.toHaveBeenCalled();
      expect(mockLockAcquire).not.toHaveBeenCalled();
    });
  }
});

// ── Transition validation (issue #1469 / #1471) ──────────────────────────────

describe('updateRefundStatus — illegal state transitions (#1469 / #1471)', () => {
  const illegalCases = [
    // Out-of-order forward transitions
    { from: 'approval_pending', to: 'submitted'       },
    { from: 'approval_pending', to: 'confirmed'       },
    { from: 'pending',          to: 'confirmed'       },
    // Backwards transitions
    { from: 'pending',          to: 'approval_pending'},
    { from: 'submitted',        to: 'approval_pending'},
    { from: 'submitted',        to: 'pending'         },
    { from: 'confirmed',        to: 'pending'         },
    // Transitions out of terminal states
    { from: 'confirmed',        to: 'failed'          },
    { from: 'failed',           to: 'pending'         },
    { from: 'failed',           to: 'submitted'       },
    { from: 'failed',           to: 'confirmed'       },
    // Self-transitions
    { from: 'pending',          to: 'pending'         },
    { from: 'confirmed',        to: 'confirmed'       },
  ];

  for (const { from, to } of illegalCases) {
    it(`rejects ${from} → ${to} with INVALID_STATUS_TRANSITION`, async () => {
      const doc = mockRefund(from);
      mockRefundFindById.mockResolvedValue(doc);

      const err = await updateRefundStatus(REFUND_ID, to).catch(e => e);

      expect(err.code).toBe('INVALID_STATUS_TRANSITION');
      expect(err.currentStatus).toBe(from);
      expect(err.requestedStatus).toBe(to);
      // The document must NOT have been saved
      expect(doc.save).not.toHaveBeenCalled();
    });
  }
});

// ── Distributed lock (issue #1470 / #1429) ───────────────────────────────────

describe('updateRefundStatus — distributed lock (#1470 / #1429)', () => {
  it('acquires the lock with the correct per-payment key', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'submitted');

    const expectedKey = refundLockKey(SCHOOL_ID, TX_HASH);
    expect(mockLockAcquire).toHaveBeenCalledWith(expectedKey, expect.any(Number));
  });

  it('releases the lock after a successful update', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'submitted');

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'tok-1'
    );
  });

  it('throws REFUND_LOCK_CONTENDED when the lock is already held by another caller', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById.mockResolvedValue(doc);
    mockLockAcquire.mockResolvedValueOnce(null); // lock contended

    const err = await updateRefundStatus(REFUND_ID, 'submitted').catch(e => e);

    expect(err.code).toBe('REFUND_LOCK_CONTENDED');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('simulates concurrent duplicate webhook: exactly one wins when two calls race', async () => {
    const docA = mockRefund('pending');
    const docB = mockRefund('pending');

    // First call acquires the lock; second call is rejected
    mockLockAcquire
      .mockResolvedValueOnce({ token: 'tok-A', fencingToken: 1 }) // call A
      .mockResolvedValueOnce(null);                               // call B

    mockRefundFindById
      .mockResolvedValueOnce(docA) // call A — initial fetch
      .mockResolvedValueOnce(docA) // call A — re-fetch inside lock
      .mockResolvedValueOnce(docB) // call B — initial fetch
      .mockResolvedValueOnce(docB); // call B — re-fetch inside lock (won't be reached)

    const [r1, r2] = await Promise.allSettled([
      updateRefundStatus(REFUND_ID, 'submitted'),
      updateRefundStatus(REFUND_ID, 'submitted'),
    ]);

    const succeeded = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected  = [r1, r2].filter(r => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('REFUND_LOCK_CONTENDED');
    // Only one save should have occurred
    const savedCount = [docA, docB].filter(d => d.save.mock.calls.length > 0).length;
    expect(savedCount).toBe(1);
  });
});

// ── Lock always released (issue #1470) ───────────────────────────────────────

describe('updateRefundStatus — lock always released on error', () => {
  it('releases the lock when the transition is illegal', async () => {
    const doc = mockRefund('confirmed'); // terminal
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'pending').catch(() => {});

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'tok-1'
    );
  });

  it('releases the lock when refund.save() throws', async () => {
    const doc = mockRefund('pending');
    doc.save.mockRejectedValueOnce(new Error('DB write error'));
    mockRefundFindById.mockResolvedValue(doc);

    await updateRefundStatus(REFUND_ID, 'submitted').catch(() => {});

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'tok-1'
    );
  });

  it('releases the lock when the re-fetched refund is missing', async () => {
    const doc = mockRefund('pending');
    // First fetch succeeds (needed for lock key); second fetch returns null
    mockRefundFindById
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(null);

    await updateRefundStatus(REFUND_ID, 'submitted').catch(() => {});

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'tok-1'
    );
  });
});

// ── Refund not found (#1429) ─────────────────────────────────────────────────

describe('updateRefundStatus — refund not found', () => {
  it('throws NOT_FOUND when the initial findById returns null', async () => {
    mockRefundFindById.mockResolvedValueOnce(null);

    const err = await updateRefundStatus(REFUND_ID, 'submitted').catch(e => e);

    expect(err.code).toBe('NOT_FOUND');
    expect(mockLockAcquire).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the re-fetch inside the lock returns null', async () => {
    const doc = mockRefund('pending');
    mockRefundFindById
      .mockResolvedValueOnce(doc)   // initial fetch
      .mockResolvedValueOnce(null); // re-fetch inside lock

    const err = await updateRefundStatus(REFUND_ID, 'submitted').catch(e => e);

    expect(err.code).toBe('NOT_FOUND');
    expect(doc.save).not.toHaveBeenCalled();
  });
});
