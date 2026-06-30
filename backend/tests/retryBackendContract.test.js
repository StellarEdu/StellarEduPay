'use strict';

/**
 * Shared retry-backend contract test (Issue #81).
 *
 * Both retry backends — BullMQ (Redis) and the MongoDB fallback — must classify
 * failures identically against the single shared contract (retryContract.js).
 * This suite runs the SAME assertions against the classification each backend
 * actually uses, so the two cannot silently diverge.
 *
 * The classification is the part of the contract that is backend-independent and
 * unit-testable without live Redis/Mongo. Durability/ordering/rate-limit
 * differences are documented (and intentionally NOT unified) in
 * docs/retry-backends.md.
 */

const retryContract = require('../src/services/retryContract');

// The classifier as exposed by each backend.
const bullmqClassify = require('../src/services/bullMQRetryService').classifyError;

// The MongoDB backend uses retryContract.isPermanent() directly; expose an
// equivalent classifier so the same cases run against it.
const mongoIsPermanent = retryContract.isPermanent;

const CASES = [
  { name: 'on-chain failure', error: { code: 'TX_FAILED' }, permanent: true, classification: 'permanent' },
  { name: 'missing memo', error: { code: 'MISSING_MEMO' }, permanent: true, classification: 'permanent' },
  { name: 'duplicate tx', error: { code: 'DUPLICATE_TX' }, permanent: true, classification: 'permanent' },
  { name: 'network error code', error: { code: 'ETIMEDOUT' }, permanent: false, classification: 'transient' },
  { name: 'stellar network error', error: { code: 'STELLAR_NETWORK_ERROR' }, permanent: false, classification: 'transient' },
  { name: 'transient by message', error: { message: 'temporary network blip' }, permanent: false, classification: 'transient' },
  { name: 'unknown error', error: { code: 'WAT' }, permanent: false, classification: 'unknown' },
];

describe('retry contract — shared classification', () => {
  test.each(CASES)('classifies "$name" as $classification', ({ error, classification }) => {
    expect(retryContract.classifyError(error)).toBe(classification);
  });
});

// The "contract" run against BOTH backends: same input → same permanent decision.
const BACKENDS = [
  { backend: 'bullmq', isPermanent: (e) => bullmqClassify(e) === 'permanent' },
  { backend: 'mongodb', isPermanent: (e) => mongoIsPermanent(e) },
];

describe.each(BACKENDS)('retry backend contract: $backend', ({ isPermanent }) => {
  test.each(CASES)('permanent decision for "$name" matches contract', ({ error, permanent }) => {
    expect(isPermanent(error)).toBe(permanent);
  });
});

describe('both backends agree on every case', () => {
  test.each(CASES)('"$name" — bullmq and mongodb agree', ({ error }) => {
    const bullmqPermanent = bullmqClassify(error) === 'permanent';
    const mongoPermanent = mongoIsPermanent(error);
    expect(bullmqPermanent).toBe(mongoPermanent);
  });
});
