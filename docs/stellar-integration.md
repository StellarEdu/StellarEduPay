# Stellar Integration

StellarEduPay uses the **Stellar Horizon API** to read blockchain transactions — the backend never holds or requires the school's private key. The school wallet is read-only from the backend's perspective; only the school administrator controls it via their own Stellar wallet application.

---

## Table of Contents

- [Testnet vs Mainnet](#testnet-vs-mainnet)
- [Testnet Setup for Contributors](#testnet-setup-for-contributors)
- [The Memo Field: Student Identification](#the-memo-field-student-identification)
- [Accepted Assets](#accepted-assets)
- [How syncPayments Works](#how-syncpayments-works)
- [How verifyTransaction Works](#how-verifytransaction-works)
- [Fee Validation](#fee-validation)
- [Confirmation Threshold & Finality State Machine](#confirmation-threshold--finality-state-machine)
- [Fraud & Anomaly Detection](#fraud--anomaly-detection)
- [School Wallet Funding Check](#school-wallet-funding-check)
- [Retry Behaviour](#retry-behaviour)
- [Verifying a Payment Independently](#verifying-a-payment-independently)

---

## Testnet vs Mainnet

Network selection is controlled by a single environment variable:

```env
STELLAR_NETWORK=testnet   # default — safe for development
STELLAR_NETWORK=mainnet   # production — real assets
```

Internally, `backend/src/config/index.js` derives everything else from this value:

```js
const IS_TESTNET  = STELLAR_NETWORK !== 'mainnet';

const HORIZON_URL =
  process.env.HORIZON_URL ||
  (IS_TESTNET
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org');

const USDC_ISSUER =
  process.env.USDC_ISSUER ||
  (IS_TESTNET
    ? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'  // testnet USDC
    : 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'); // mainnet USDC
```

The Horizon server instance is created once in `backend/src/config/stellarConfig.js` and shared across all services:

```js
const server = new StellarSdk.Horizon.Server(config.HORIZON_URL, {
  timeout: config.STELLAR_TIMEOUT_MS, // default 10 000 ms
});
```

You should never need to change `HORIZON_URL` manually — switching `STELLAR_NETWORK` is enough.

---

## Testnet Setup for Contributors

1. Visit [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test) and click **Generate keypair**.
2. Copy the **Public Key** (starts with `G`) — this is your `SCHOOL_WALLET_ADDRESS`.
3. Keep the **Secret Key** (starts with `S`) offline. The backend never needs it.
4. Click **Fund account with Friendbot** to receive free test XLM.
5. Add the public key to `backend/.env`:

```env
STELLAR_NETWORK=testnet
SCHOOL_WALLET_ADDRESS=G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE
```

Alternatively, generate a wallet from the command line:

```bash
cd backend && npm install
node scripts/create-school-wallet.js
```

To send a test payment, use [Stellar Laboratory → Transaction Builder](https://laboratory.stellar.org/#txbuilder?network=test):
- **Destination**: your `SCHOOL_WALLET_ADDRESS`
- **Amount**: any value within your configured limits
- **Memo (text)**: the student ID (e.g. `STU001`)

---

## The Memo Field: Student Identification

Stellar transactions include an optional **memo** field (up to 28 characters). StellarEduPay uses this to embed the student ID so payments can be matched automatically — no manual reconciliation needed.

```
Transaction on Stellar network:
  From:   GPARENT_WALLET_ADDRESS
  To:     GSCHOOL_WALLET_ADDRESS
  Amount: 250 XLM
  Memo:   "STU001"   ← student ID
```

When the backend syncs or verifies a transaction, it:

1. Reads `tx.memo` and trims whitespace.
2. Rejects the transaction if the memo is empty (`MISSING_MEMO`).
3. Looks up a `PaymentIntent` with `{ schoolId, memo, status: 'pending' }`.
4. Resolves the student from the intent and validates the amount against their fee.

**Important constraints:**
- The memo must match a student ID exactly (case-sensitive).
- Memos are scoped to a school — the same memo value can exist across different schools without collision.

---

## Accepted Assets

The system accepts one asset at a time, configured via `ACCEPTED_ASSET` (default: `XLM`):

```env
ACCEPTED_ASSET=XLM    # Stellar Lumens (native asset)
ACCEPTED_ASSET=USDC   # USD Coin (stablecoin)
```

Asset definitions live in `backend/src/config/stellarConfig.js`:

```js
const ALL_ASSETS = {
  XLM: {
    code: 'XLM',
    type: 'native',
    issuer: null,
    displayName: 'Stellar Lumens',
    decimals: 7,
  },
  USDC: {
    code: 'USDC',
    type: 'credit_alphanum4',
    issuer: config.USDC_ISSUER,   // auto-resolved per network
    displayName: 'USD Coin',
    decimals: 7,
  },
};
```

`isAcceptedAsset(assetCode, assetType)` is called on every payment operation during sync and verification. Transactions using any other asset are silently skipped.

To add a new asset, add an entry to `ALL_ASSETS` and update the `ACCEPTED_ASSET` validation list.

---

## How syncPayments Works

`syncPaymentsForSchool(school)` in `backend/src/services/stellarService.js` is the core reconciliation loop. It is called by the background polling service on the interval set by `POLL_INTERVAL_MS` (default: 30 000 ms).

### Step-by-step

**1. Fetch recent transactions from Horizon**

```js
let page = await withStellarRetry(() =>
  server
    .transactions()
    .forAccount(stellarAddress)
    .order('desc')   // newest first
    .limit(200)
    .call()
);
```

Transactions are fetched in pages of 200, newest first. Pagination continues until a previously-recorded transaction is encountered or the last page is reached.

**2. Skip already-processed transactions**

```js
const existing = await Payment.findOne({ txHash: tx.hash });
if (existing) { done = true; break; }
```

Once a known transaction is found, the loop stops — all older transactions have already been processed.

**3. Extract and validate the payment operation**

`extractValidPayment(tx, stellarAddress)` performs three checks:

```js
// a. Transaction must have succeeded on-chain
if (!tx.successful) return null;

// b. Memo must be present
const memo = tx.memo ? tx.memo.trim() : null;
if (!memo) return null;

// c. Must contain a payment operation targeting the school wallet
const payOp = ops.records.find(
  op => op.type === 'payment' && op.to === walletAddress
);
if (!payOp) return null;

// d. Asset must be accepted
const asset = detectAsset(payOp);
if (!asset) return null;
```

**4. Match to a PaymentIntent**

```js
const intent = await PaymentIntent.findOne({
  schoolId,
  memo,
  status: 'pending',
});
if (!intent) continue;
```

Only transactions with a matching pending intent are processed. This prevents arbitrary payments from being recorded.

**5. Validate payment amount**

```js
// Global min/max limits
const limitValidation = validatePaymentAmount(paymentAmount);
if (!limitValidation.valid) continue;

// Fee comparison against the intent amount
const feeValidation = validatePaymentAgainstFee(paymentAmount, intent.amount);
```

Underpaid transactions are recorded with `status: 'FAILED'` and `isSuspicious: true` but do not update the student's `feePaid` flag.

**6. Calculate cumulative payment status**

Because a student may pay in multiple instalments, the sync aggregates all previous confirmed payments:

```js
const previousTotal = previousPayments[0]?.total ?? 0;
const cumulativeTotal = parseFloat((previousTotal + paymentAmount).toFixed(7));

// 'underpaid' | 'overpaid' | 'valid'
let cumulativeStatus;
if (cumulativeTotal < student.feeAmount)      cumulativeStatus = 'underpaid';
else if (cumulativeTotal > student.feeAmount) cumulativeStatus = 'overpaid';
else                                          cumulativeStatus = 'valid';
```

**7. Check confirmation status**

```js
const confirmation = await determineConfirmationState(
  txLedger, CONFIRMATION_STATES.DETECTED, isSuspicious
);
const isConfirmed = isConfirmedOrAbove(confirmation.state);
const confirmationStatus = confirmation.confirmationStatus;
```

See [Confirmation Threshold & Finality State Machine](#confirmation-threshold--finality-state-machine) for details.

**8. Fraud detection**

```js
const collision = await detectMemoCollision(
  memo, senderAddress, paymentAmount, student.feeAmount, txDate, schoolId
);
const crossSchoolCollision = await detectCrossSchoolMemoCollision(memo, schoolId, txDate);
```

See [Fraud & Anomaly Detection](#fraud--anomaly-detection).

**9. Persist the payment record**

```js
await Payment.create({
  schoolId, studentId: intent.studentId, txHash: tx.hash,
  amount: paymentAmount, feeAmount: intent.amount,
  feeValidationStatus: cumulativeStatus, excessAmount,
  status: 'confirmed', memo, senderAddress,
  isSuspicious: collision.suspicious,
  suspicionReason: collision.reason,
  ledger: txLedger, confirmationStatus, confirmedAt: txDate,
});
```

**10. Update student record and close the intent**

Only if the transaction is confirmed and not suspicious:

```js
await Student.findOneAndUpdate(
  { schoolId, studentId: intent.studentId },
  { totalPaid: cumulativeTotal, feePaid: cumulativeTotal >= student.feeAmount }
);

await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'completed' });
```

---

## How verifyTransaction Works

`verifyTransaction(txHash, walletAddress)` in `stellarService.js` is called by the payment controller when a client submits a transaction hash for manual verification (`POST /api/payments/verify`).

### Step-by-step

```js
// 1. Fetch the transaction from Horizon
const tx = await withStellarRetry(
  () => server.transactions().transaction(txHash).call()
);

// 2. Confirm it succeeded on-chain
if (tx.successful === false) throw { code: 'TX_FAILED' };

// 3. Require a non-empty memo
const memo = tx.memo ? tx.memo.trim() : null;
if (!memo) throw { code: 'MISSING_MEMO' };

// 4. Find a payment operation targeting the school wallet
const payOp = ops.records.find(
  op => op.type === 'payment' && op.to === walletAddress
);
if (!payOp) throw { code: 'INVALID_DESTINATION' };

// 5. Confirm the asset is accepted
const asset = detectAsset(payOp);
if (!asset) throw { code: 'UNSUPPORTED_ASSET' };

// 6. Validate amount against global limits
const limitValidation = validatePaymentAmount(amount);
if (!limitValidation.valid) throw { code: limitValidation.code };

// 7. Look up student and compare against their fee
const student = await Student.findOne({ studentId: memo });
const feeValidation = feeAmount != null
  ? validatePaymentAgainstFee(amount, feeAmount)
  : { status: 'unknown', message: 'Student not found' };
```

The function returns a structured result — it does **not** write to the database. Persisting the payment is the caller's responsibility.

```js
return {
  hash, memo, studentId: memo,
  amount, assetCode, assetType,
  feeAmount, feeValidation,
  networkFee,   // tx.fee_paid converted from stroops to XLM
  date, ledger, senderAddress,
};
```

### Error codes

| Code | Meaning |
|---|---|
| `TX_FAILED` | Transaction was not successful on Stellar |
| `MISSING_MEMO` | No memo on the transaction |
| `INVALID_DESTINATION` | No payment operation to the school wallet |
| `UNSUPPORTED_ASSET` | Asset not in `ACCEPTED_ASSETS` |
| `AMOUNT_TOO_LOW` | Below `MIN_PAYMENT_AMOUNT` |
| `AMOUNT_TOO_HIGH` | Above `MAX_PAYMENT_AMOUNT` |

---

## Fee Validation

`validatePaymentAgainstFee(paymentAmount, expectedFee)` compares the paid amount against the student's assigned fee:

```js
if (paymentAmount < expectedFee) {
  return { status: 'underpaid',  excessAmount: 0,      message: '...' };
}
if (paymentAmount > expectedFee) {
  return { status: 'overpaid',   excessAmount: excess, message: '...' };
}
return   { status: 'valid',      excessAmount: 0,      message: '...' };
```

| Status | `feePaid` updated? | Reconciliation | Notes |
|---|---|---|---|
| `valid` | ✅ Yes | N/A | Exact match |
| `overpaid` | ✅ Yes | N/A | Excess recorded; student is considered paid |
| `partial` / `underpaid` | ✅ Yes (cumulative) | N/A | Payment accepted and recorded as `SUCCESS`; cumulative balance updated. |
| `unknown` | ❌ No | N/A | Student not found in database |

### Underpaid Payment Reconciliation (Issue #1039)

Underpaid/partial payments are **accepted and recorded as `SUCCESS`** rather than rejected, because funds have already arrived on-chain. Once a partial payment is recorded, it contributes to the cumulative total and the student's remaining balance is updated accordingly.

The payment carries an `underpaidReconciliation` sub-document on the `Payment` model tracking:
- `status`: one of `pending`, `partial_credited`, `refund_initiated`, `refund_completed`
- `appliedCredit`: amount credited to student balance
- `refundTxHash`: Stellar tx hash if refunded
- `creditAppliedAt`, `refundInitiatedAt`, `refundCompletedAt`: audit timestamps

These fields are populated by the refund service when a refund is processed.
Partial payments are credited immediately toward the student's cumulative
balance; the remaining shortfall is reflected in the student's
`remainingBalance`.

---

## Confirmation Threshold & Finality State Machine

Stellar finalises transactions in 3–5 seconds, but StellarEduPay adds an extra safety margin by requiring a minimum number of ledgers to have closed after the transaction's ledger before treating a payment as final. This is implemented as an explicit, documented state machine in `backend/src/services/paymentConfirmationStateMachine.js` (issue #747).

### States

Every payment carries a fine-grained `confirmationState`, in addition to the legacy 3-value `confirmationStatus` field that existing consumers (admin queries, balance updates, receipt emails) still read:

| `confirmationState` | Meaning | Ledger depth (latest − tx ledger) |
|---|---|---|
| `detected` | Tx observed on Horizon, 0 ledgers closed since | `depth == 0` |
| `pending` | Awaiting enough depth to be considered safe against a Horizon failover/replay | `0 < depth < CONFIRMATION_THRESHOLD` |
| `confirmed` | Safe to treat as real for balance/UI purposes | `depth >= CONFIRMATION_THRESHOLD` |
| `finalized` | Practically irreversible — no manual correction should ever be needed | `depth >= FINALIZATION_THRESHOLD` |
| `failed` | Flagged suspicious (memo collision / abnormal pattern) or otherwise invalid — terminal | n/a |

```env
CONFIRMATION_THRESHOLD=2    # default — wait for 2 ledgers after the tx ledger
FINALIZATION_THRESHOLD=10   # default — 5x CONFIRMATION_THRESHOLD when unset; must be >= it
```

`deriveLegacyConfirmationStatus` maps the fine-grained state onto the legacy field: `detected`/`pending` → `pending_confirmation`, `confirmed`/`finalized` → `confirmed`, `failed` → `failed`.

### Idempotent, re-runnable transitions

`computeTargetState({ txLedger, latestLedgerSequence, isSuspicious, confirmationThreshold, finalizationThreshold })` is a pure function: the same inputs always yield the same target state. `resolveNextState(currentState, targetState)` then applies the target against the payment's current state under three rules:

1. **Terminal states never move** — `finalized` and `failed` have no outgoing transitions.
2. **A target that doesn't outrank the current state is a no-op** — re-polling the same (or an overlapping/stale) ledger range never regresses or incorrectly re-advances a payment.
3. **Forward jumps may skip intermediate states** — a payment can be first observed already past `CONFIRMATION_THRESHOLD` and go straight from `detected` to `confirmed`.

`stellarService.determineConfirmationState(txLedger, currentState, isSuspicious)` ties this together: it fetches the latest Horizon ledger sequence, computes the target state, and resolves it against the payment's current state, returning `{ state, changed, confirmationStatus, latestLedgerSequence }`. `changed` is `false` whenever a re-poll doesn't move the payment forward.

Payments that have not yet reached `confirmed` are swept by `finalizeConfirmedPayments(schoolId)`, run periodically, which advances each non-terminal payment (`detected`/`pending` → `confirmed` → `finalized`) using the same idempotent machinery — safe to call repeatedly or concurrently for the same school.

Unit tests for the state machine (including re-poll idempotency) live in `backend/tests/paymentConfirmationStateMachine.test.js` and `backend/tests/confirmationStateRepollAndCrossSchoolCollision.test.js`.

---

## Fraud & Anomaly Detection

### Memo collision

`detectMemoCollision` flags a transaction as suspicious if the same memo (student ID) was used by a **different sender address** within the last 24 hours:

```js
const recentFromOtherSender = await Payment.findOne({
  schoolId,
  studentId: memo,
  senderAddress: { $ne: senderAddress },
  confirmedAt: { $gte: windowStart },  // 24-hour window
});
```

This catches cases where someone attempts to impersonate a student's payment.

### Cross-school memo collision

Memos (student IDs) are only unique within a school's own roster, so two unrelated schools can legitimately assign the same ID to different students. `detectCrossSchoolMemoCollision` flags it anyway when the same memo was paid to a **different school** within the last 24 hours, since that pattern is worth a manual look even though it isn't necessarily fraud:

```js
const recentFromOtherSchool = await Payment.findOne({
  schoolId: { $ne: schoolId },
  studentId: memo,
  confirmedAt: { $gte: windowStart },  // 24-hour window
});
```

This is independent of `detectMemoCollision`, which is single-school and keyed on sender address.

### Abnormal patterns

`detectAbnormalPatterns` checks two additional signals:

- **Velocity**: the same sender makes more than 3 payments within 10 minutes.
- **Unusual amount**: the payment is at least `suspiciousPaymentMultiplier`× or at most 1/`suspiciousPaymentMultiplier` of the expected fee (both bounds inclusive). The reason recorded on the payment includes the ratio and threshold, e.g. `Unusual payment amount (ratio 3.00, threshold 3.0×)`.

Suspicious payments are still recorded but `isSuspicious: true` prevents the student's `feePaid` flag from being updated until an admin reviews the record.

#### Per-school amount thresholds

`suspiciousPaymentMultiplier` is a per-school field (`backend/src/models/schoolModel.js`), default `3.0`, allowed range `1.1`–`100`. It can be set on `POST /api/schools` and changed with `PATCH /api/schools/:schoolId`; out-of-range values are rejected with `400 VALIDATION_ERROR` on create and `400 INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER` on update.

| Multiplier | Flags payments | Character |
|---|---|---|
| 1.1 | ≥1.1× or ≤0.91× of the fee | Very strict |
| 1.5 | ≥1.5× or ≤0.67× | Strict |
| 3.0 | ≥3× or ≤0.33× | Default |
| 5.0 | ≥5× or ≤0.2× | Lenient |

A flat fee multiplier mis-fires for schools whose normal payments cluster away from the expected fee, so each school can instead opt into a threshold based on its **own** confirmed-payment history via `suspiciousAmountConfig`:

```json
PATCH /api/schools/:schoolId
{
  "suspiciousAmountConfig": {
    "mode": "historical",
    "historicalWindowDays": 90,
    "historicalStdDevMultiplier": 3.0,
    "historicalMinSamples": 20
  }
}
```

- `mode: "fee_multiplier"` (default) — the multiplier rule above.
- `mode: "historical"` — flags an amount more than `historicalStdDevMultiplier` standard deviations from the school's mean confirmed-payment amount over the last `historicalWindowDays` days. Until the school has `historicalMinSamples` confirmed payments, detection falls back to the fee multiplier to avoid cold-start false positives.

#### Reviewing flagged payments

- `GET /api/payments/suspicious` — list the school's flagged payments.
- `PATCH /api/payments/:txHash/suspicion-review` — body `{ "action": "clear" | "confirm_fraud", "note": "..." }`. `clear` removes the flag (false positive); `confirm_fraud` records the determination and keeps it.

The outcome is stored on the payment (`suspicionReviewStatus`, `suspicionReviewedBy`, `suspicionReviewedAt`, `suspicionReviewNote`) and every decision writes a `payment_suspicion_review` audit log entry. The Prometheus counter `suspicious_payment_flagged{school_id}` makes flagged volume alertable per tenant.

---

## School Wallet Funding Check

When a school is created (`POST /api/schools`) or its `stellarAddress` changes, `verifyStellarAccountFunding` (`backend/src/services/stellarAccountVerificationService.js`) asks Horizon whether the account exists and holds at least 1 XLM. The check is advisory and never blocks setup:

| Horizon result | Response |
|---|---|
| Funded (≥1 XLM) | `201 Created` / `200 OK` |
| Account missing (404) or <1 XLM | `202 Accepted` with `"warning": "STELLAR_ACCOUNT_UNFUNDED"` — the school is still saved |
| Timeout (3 s) or network/5xx/429 error | `201 Created` / `200 OK` — logged at warn level, no warning field |

An invalid public key is still a hard `400 INVALID_STELLAR_ADDRESS`. Updates that do not touch `stellarAddress` skip the check.

---

## Retry Behaviour

All Horizon API calls are wrapped in `withStellarRetry` (`backend/src/utils/withStellarRetry.js`), which retries transient failures with exponential backoff and jitter:

```js
const data = await withStellarRetry(
  () => server.transactions().transaction(txHash).call(),
  { label: 'verifyTransaction', maxAttempts: 3, baseDelay: 1000 }
);
```

Retried errors include network timeouts (`ETIMEDOUT`, `ECONNREFUSED`), HTTP 429 (rate-limited), and HTTP 5xx (server errors). Permanent 4xx errors are thrown immediately without retrying.

Backoff formula: `min(baseDelay × 2^(attempt-1), 10 000) + random jitter (±30%)`

Environment overrides:

```env
STELLAR_CALL_RETRY_ATTEMPTS=3     # default
STELLAR_CALL_RETRY_DELAY_MS=1000  # default initial delay
```

---

## Verifying a Payment Independently

Any transaction can be verified on a public Stellar explorer without using this application:

- Testnet: https://stellar.expert/explorer/testnet
- Mainnet: https://stellar.expert/explorer/public

Search by transaction hash or the school wallet address to see the full on-chain record.
