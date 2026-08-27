# Architecture

StellarEduPay is a three-tier application: a Next.js frontend, a Node.js/Express backend, and the Stellar blockchain as the payment ledger. MongoDB stores student records and payment metadata; the Stellar Horizon API is the authoritative source for transaction data.

---

## Table of Contents

- [High-Level Overview](#high-level-overview)
- [Component Diagram](#component-diagram)
- [Data Flow: Payment Initiation to Confirmation](#data-flow-payment-initiation-to-confirmation)
- [Backend Services](#backend-services)
- [Controllers](#controllers)
- [Middleware](#middleware)
- [MongoDB Schema Relationships](#mongodb-schema-relationships)
- [Replica Set Requirement](#replica-set-requirement)
- [Background Workers](#background-workers)
- [Queue Durability](#queue-durability)
- [Multi-School Tenancy](#multi-school-tenancy)
- [Error Handling and Resilience](#error-handling-and-resilience)

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Parent / Admin Browser                    │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  Next.js Frontend (React)                    │
│  PaymentForm · VerifyPayment · Dashboard · Reports          │
└────────────────────────┬────────────────────────────────────┘
                         │ REST API (JSON)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Express.js Backend (Node.js)                    │
│                                                             │
│  Routes → Controllers → Services → Models                   │
│                                                             │
│  Background workers:                                        │
│    transactionService  (polling)                            │
│    retryService        (outage recovery)                    │
│    consistencyScheduler (drift detection)                   │
│    reminderService     (fee reminders)                      │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────┐    ┌─────────────────────────────────┐
│       MongoDB        │    │     Stellar Horizon API          │
│                      │    │                                 │
│  School             │    │  Transaction ledger             │
│  Student            │    │  Account operations             │
│  Payment            │    │  Ledger sequence                │
│  PaymentIntent      │    │                                 │
│  FeeStructure       │    │  testnet.stellar.org (dev)      │
│  PendingVerification│    │  horizon.stellar.org (prod)     │
│  Dispute            │    └─────────────────────────────────┘
└──────────────────────┘
```

---

## Component Diagram

```
frontend/src/
├── pages/
│   ├── pay-fees.jsx        ← PaymentForm + VerifyPayment
│   ├── dashboard.jsx       ← student list, sync button
│   └── reports.jsx         ← report download
├── components/
│   ├── PaymentForm.jsx     ← student lookup + instructions + history
│   ├── VerifyPayment.jsx   ← tx hash verification UI
│   └── TransactionCard.jsx ← single payment display + dispute flag
└── services/
    └── api.js              ← axios client, all API calls

backend/src/
├── app.js                  ← Express setup, route mounting, startup
├── config/
│   ├── index.js            ← env var loading and validation
│   └── stellarConfig.js    ← Horizon server, accepted assets
├── routes/                 ← thin route files, map HTTP → controller
├── controllers/            ← request/response handling
├── services/               ← business logic (no HTTP concerns)
├── models/                 ← Mongoose schemas
├── middleware/             ← auth, validation, rate limiting, idempotency
└── utils/                  ← paymentLimits, withStellarRetry, logger
```

---

## Data Flow: Payment Initiation to Confirmation

### Step 1 — Fee structure setup (admin, one-time)

```
POST /api/fees
  → feeController.createFeeStructure
  → FeeStructure.create({ schoolId, className, feeAmount, academicYear })
```

### Step 2 — Student registration (admin)

```
POST /api/students
  → studentController.createStudent
  → FeeStructure.findOne({ schoolId, className })   ← auto-assigns feeAmount
  → Student.create({ schoolId, studentId, name, class, feeAmount })
```

### Step 3 — Payment instructions (parent)

```
GET /api/payments/instructions/:studentId
  → paymentController.getPaymentInstructions
  → PaymentIntent.create({ schoolId, studentId, memo: studentId, amount, expiresAt })
  → returns { walletAddress, memo, acceptedAssets, paymentLimits }
```

The parent's Stellar wallet sends XLM or USDC to the school wallet address with the student ID as the transaction memo.

### Step 4 — Blockchain sync (background or manual)

```
POST /api/payments/sync  (or automatic via transactionService every 30s)
  → stellarService.syncPaymentsForSchool(school)
      │
      ├─ Horizon: fetch latest 200 txs for school wallet (newest first)
      │
      ├─ For each tx:
      │   ├─ Skip if txHash already in Payment collection
      │   ├─ extractValidPayment: check tx.successful, memo present,
      │   │   payment op targets school wallet, asset is accepted
      │   ├─ Match memo → PaymentIntent (schoolId + memo + status:pending)
      │   ├─ Validate amount against global limits (MIN/MAX_PAYMENT_AMOUNT)
      │   ├─ Calculate cumulative payment total for partial payments
      │   ├─ detectMemoCollision: flag if same memo used by different sender
      │   ├─ checkConfirmationStatus: compare tx ledger vs latest ledger
      │   └─ Payment.create(...)
      │
      └─ If confirmed + not suspicious:
          ├─ Student.update({ totalPaid, feePaid })
          └─ PaymentIntent.update({ status: 'completed' })
```

### Step 5 — Manual verification (parent)

```
POST /api/payments/verify  { txHash }
  → paymentController.verifyPayment
  → stellarService.verifyTransaction(txHash, walletAddress)
      ├─ Fetch tx from Horizon
      ├─ Validate: successful, memo present, correct destination, accepted asset
      ├─ Compare amount against student fee
      └─ Return { hash, memo, amount, feeValidation, date, networkFee }
```

### Full flow summary

```
Admin creates fee  →  Admin registers student  →  Parent gets instructions
                                                          │
                                              Parent sends XLM/USDC on Stellar
                                                          │
                                              ┌───────────▼────────────┐
                                              │  Stellar Blockchain     │
                                              │  (3-5 second finality) │
                                              └───────────┬────────────┘
                                                          │
                                              Background poller (30s interval)
                                              or POST /api/payments/sync
                                                          │
                                              stellarService.syncPaymentsForSchool
                                                          │
                                              ┌───────────▼────────────┐
                                              │  MongoDB               │
                                              │  Payment created       │
                                              │  Student.feePaid=true  │
                                              └────────────────────────┘
```

---

## Backend Services

### `stellarService.js`

The core blockchain integration layer. All Horizon API calls go through here.

| Function | Purpose |
|---|---|
| `syncPaymentsForSchool(school)` | Fetches and processes recent transactions for one school wallet |
| `verifyTransaction(txHash, walletAddress)` | Validates a single transaction by hash; returns structured result |
| `extractValidPayment(tx, walletAddress)` | Checks tx success, memo, payment op, and asset acceptance |
| `validatePaymentAgainstFee(amount, fee)` | Returns `valid` / `overpaid` / `underpaid` with excess amount |
| `detectMemoCollision(...)` | Flags if the same memo was used by a different sender within 24h |
| `detectAbnormalPatterns(...)` | Flags velocity abuse (>3 txs in 10 min) and unusual amounts |
| `checkConfirmationStatus(txLedger)` | Compares tx ledger against latest ledger sequence |
| `finalizeConfirmedPayments(schoolId)` | Promotes `pending_confirmation` payments once threshold is met |
| `recordPayment(data)` | Persists a payment, enforces uniqueness on `txHash` |

All Horizon calls are wrapped in `withStellarRetry` (exponential backoff, retries on 429/5xx/network errors).

### `transactionService.js`

Background polling service. Runs on startup and calls `syncPaymentsForSchool` for every active school in parallel on a fixed interval (`POLL_INTERVAL_MS`, default 30s).

```
startPolling()
  └─ setInterval(async () => {
       schools = School.find({ isActive: true })
       Promise.allSettled(schools.map(syncPaymentsForSchool))
     }, 30_000)
```

Errors for individual schools are logged but do not stop polling for other schools.

### `retryService.js`

Outage recovery worker. When a Stellar network call fails with a transient error, the transaction hash is stored as a `PendingVerification` document. This service runs on `RETRY_INTERVAL_MS` (default 60s), checks network reachability, and re-attempts verification with exponential backoff (1m → 2m → 4m … capped at 60m).

Permanent errors (`TX_FAILED`, `MISSING_MEMO`, `INVALID_DESTINATION`, `UNSUPPORTED_ASSET`, `DUPLICATE_TX`) are moved to `dead_letter` status immediately without retrying.

### `consistencyService.js`

Drift detection. Compares Payment documents in MongoDB against the last 200 on-chain transactions and reports mismatches:

- `missing_on_chain` — payment in DB but not found on Stellar
- `amount_mismatch` — DB amount differs from on-chain amount
- `student_mismatch` — DB `studentId` doesn't match the transaction memo

Triggered via `GET /api/consistency` or the `consistencyScheduler` background job.

### `reminderService.js`

Fee reminder scheduler. Finds students with unpaid fees and a `parentEmail`, respects `reminderCooldownHours` and `reminderMaxCount` per student, and sends emails via nodemailer (SMTP configured in `.env`).

---

## Controllers

| Controller | Routes | Responsibility |
|---|---|---|
| `paymentController` | `/api/payments/*` | Instructions, verify, sync, payment history |
| `studentController` | `/api/students/*` | CRUD, auto fee assignment from FeeStructure |
| `feeController` | `/api/fees/*` | Fee structure CRUD |
| `schoolController` | `/api/schools/*` | School registration and management |
| `reportController` | `/api/reports/*` | Payment reports, CSV export |
| `disputeController` | `/api/disputes/*` | Flag and resolve payment disputes |
| `healthController` | `/health` | Liveness check (used by Docker HEALTHCHECK) |
| `consistencyController` | `/api/consistency` | On-demand consistency check |

Controllers are thin — they validate input, call a service, and return a response. Business logic lives in services.

---

## Middleware

| Middleware | Purpose |
|---|---|
| `auth.js` | JWT verification for admin routes |
| `validate.js` | Joi schema validation on request bodies |
| `schoolContext.js` | Resolves `X-School-ID` or `X-School-Slug` header to a School document |
| `idempotency.js` | Deduplicates requests using `Idempotency-Key` header |
| `rateLimiter.js` | Per-IP rate limiting |
| `concurrentRequestHandler.js` | Circuit breaker + request queue for Horizon call bursts |
| `errorHandler.js` | Maps error codes to HTTP status codes, formats JSON error responses |
| `requestLogger.js` | Structured request/response logging |

---

## MongoDB Schema Relationships

```
School
  │  schoolId (PK)
  │  stellarAddress
  │  slug
  │
  ├──< FeeStructure
  │      schoolId (FK)
  │      className  ─────────────────────────────┐
  │      feeAmount                               │
  │                                              │ auto-assigned on student create
  ├──< Student                                   │
  │      schoolId (FK)                           │
  │      studentId (unique per school)           │
  │      class ─────────────────────────────────┘
  │      feeAmount
  │      feePaid
  │      totalPaid
  │
  ├──< PaymentIntent
  │      schoolId (FK)
  │      studentId
  │      memo (= studentId, unique)
  │      status: pending | completed | expired
  │      expiresAt
  │
  ├──< Payment
  │      schoolId (FK)
  │      studentId
  │      txHash (globally unique)
  │      amount
  │      feeValidationStatus: valid | underpaid | overpaid | unknown
  │      confirmationStatus: pending_confirmation | confirmed | failed
  │      isSuspicious
  │      confirmedAt
  │
  └──< PendingVerification
         schoolId (FK)
         txHash
         status: pending | processing | resolved | dead_letter
         attempts
         nextRetryAt
```

### Key constraints

- `txHash` is globally unique across all schools — a transaction can only be recorded once.
- `studentId` is unique per school (`{ studentId, schoolId }` compound unique index).
- `PaymentIntent.memo` is unique — prevents duplicate intents for the same student.
- `FeeStructure.className` is unique per school (`{ schoolId, className }` compound unique index).
- Payments and Students use soft delete (`deletedAt` field) — records are never hard-deleted.
- Payment audit trail is immutable once `status` reaches `SUCCESS` or `FAILED`.

---

## Concurrency Mechanism: Redis Distributed Locks (not MongoDB Transactions)

StellarEduPay's concurrency primitive for financial operations is **Redis-backed distributed locking**, not MongoDB multi-document transactions.

- **Lock service**: `backend/src/services/distributedLock.js` provides Redis-backed locks with `studentBalanceLockKey`.
- **Call sites**: `stellarService.js`, `paymentController.js`, `underpaidReconciliationService.js` use distributed locks to serialize access to shared resources (e.g. a student's balance during concurrent payments).

**Rationale:** Distributed locks are simpler to reason about than MongoDB transactions, are not affected by replica set configuration, and work across both MongoDB and external state (Stellar blockchain). They scale better under contention because lock holders are individually bounded and timeouts prevent indefinite hangs.

**Not in use:** `backend/src/services/transactionManager.js` was added in commit 43f18e0 as a MongoDB-transaction implementation but was never adopted. It remains unreferenced in the codebase (`grep -r transactionManager backend/src --include='*.js' | grep -v transactionManager.js` yields no results). The module contains latent defects (invalid aggregation operators in non-pipeline updates, unscoped upserts creating tenant-less documents with NaN balances, stale reads between multi-step updates) that would corrupt financial state if adopted. It was deleted in this change.

## Replica Set Requirement

MongoDB **multi-document transactions require a replica set (or a sharded cluster)**. This is an infrastructure requirement, not an application-code concern: against a standalone `mongod`, every attempt to start a transaction fails with

```
MongoServerError: Transaction numbers are only allowed on a replica set member or mongos
```

and no change to application code can fix it — the database must run with `--replSet` and be initiated once with `rs.initiate()`.

StellarEduPay configures MongoDB to support transactions on all environments, though transactions are not currently used on core write paths (which rely on distributed locks instead):

- `transactionPollingService.processTransaction` — records the Payment and updates the Student balance atomically
- `stellarService.verifyTransaction` — same pair of writes for manually verified payments
- `feeController` and `feeAdjustmentController` batch apply — multi-document fee updates

### How each environment complies

| Environment | Configuration |
|-------------|---------------|
| Docker Compose | `mongo` service runs `mongod --replSet rs0` with a boot-generated keyfile; its healthcheck runs `rs.initiate()` and only reports healthy once the node is PRIMARY. Backend/backup URIs include `replicaSet=rs0`. |
| CI (GitHub Actions) | Both Mongo service containers (`test` and `docker-build` jobs) start with `--replSet rs0`; their healthcheck performs `rs.initiate()` so job steps begin only after initiation. |
| Kubernetes | `deploy/k8s/mongodb-statefulset.yaml` runs `--replSet rs0 --bind_ip_all` with a postStart hook that initiates rs0; the readiness probe gates traffic on writability (`db.hello().isWritablePrimary`). MONGO_URI must include `?replicaSet=rs0`. |
| Local development | Run `mongod --replSet rs0` and call `rs.initiate()` once (see README "Prerequisites"). |

> **Note**: MongoDB Atlas deployments are replica sets by default and need no extra configuration. A standalone `mongod` is sufficient ONLY where no code path opens a session — which is nowhere in this backend.

---

## Background Workers

All workers start on server boot inside the `connectDatabase().then(...)` callback in `app.js` and shut down gracefully on `SIGTERM`/`SIGINT`.

| Worker | Start function | Interval | Purpose |
|---|---|---|---|
| Transaction poller | `startPolling()` | `POLL_INTERVAL_MS` (30s) | Sync new payments from Stellar |
| Retry worker | `startRetryWorker()` | `RETRY_INTERVAL_MS` (60s) | Re-attempt failed verifications (MongoDB-backed when Redis is absent) |
| Consistency scheduler | `startConsistencyScheduler()` | configurable | Detect DB/chain drift |
| Reminder scheduler | `startReminderScheduler()` | `REMINDER_INTERVAL_MS` (24h) | Send fee reminder emails |
| TX processing queue worker | `startTxQueueWorker()` | event-driven (BullMQ, **Durable via MongoDB outbox — see Queue Durability below**) | Process queued transactions submitted via `POST /api/payments/process-queue`, the stuck-payment reconciler, and any internal pathway |
| Transaction retry + DLQ worker | `initializeRetryQueue()` | event-driven (BullMQ, configurable backoff with jitter) | Re-attempt transaction verifications on transient Horizon errors; permanent failures and retry exhaustion land in the dedicated dead-letter queue |
| Report generation worker | `startReportQueueWorker()` | event-driven (BullMQ, **durable via `ReportJob` collection**) | Generate CSV/JSON reports and update `ReportJob` status to `completed` / `failed` |

---

## Queue Durability

The codebase has three asynchronous queues. None of them relies solely on Redis — every queue has a MongoDB-backed outbox (or mirror) so no work-in-progress is silently dropped across a server restart, pod eviction, or Redis outage. **There is no in-memory queue that holds primary submission responsibility.**

### Transaction processing queue — `queue/transactionQueue.js`

This is the queue that holds the primary transaction-submission pathway used by:

- The stuck-payment reconciliation scheduler (`stuckPaymentReconciliation.reconcileStuckPayments`)
- Any internal/manual pathway that re-queues a known `txHash` for re-processing

**Two-tier durability model:**

1. **MongoDB first (durable backing).** Every `enqueueTransaction(txHash, ctx)` performs an `upsert` on `PendingVerification` (scoped on `txHash`, which is globally unique). The document moves through the lifecycle: `pending → processing → resolved | dead_letter`. MongoDB is the durable backing — BullMQ is the actual processor.
2. **BullMQ second (best-effort dispatcher).** After MongoDB is written, the job is added to BullMQ with `jobId: txHash` so duplicate enqueues are deduplicated.

If BullMQ is unavailable at module-load time (Redis down or network blip means `getRedisClient()` returns `null`, so the module-scope `transactionQueue` instance is `null`), the runtime enters MongoDB-only degraded mode. In that mode the MongoDB record is the source of truth — the job is *still safe* and will be picked up on the next process restart:

- `enqueueTransaction(txHash, ctx)` writes the MongoDB record and returns `null` (the BullMQ step is skipped, `txHash` is just persisted for the next startup).
- `recoverPendingJobs()` returns `0` and skips the BullMQ requeue loop (no `transactionQueue` to add to).
- `markResolved`, `markDead`, `markInterrupted`, and `getJobStatus` (the MongoDB-side inspection) continue to work normally because they don't touch Redis.
- On the **next process restart** with Redis reachable, the startup sweep re-enqueues every still-pending doc. (In-process auto-heal is not implemented — a restart is required to flip out of MongoDB-only mode.)

**Restart recovery.** On server start, `recoverPendingJobs()` runs twice by design — first in `app.js` (after `connectDatabase().then(...)` resolves and `reconcileStuckPayments()` has just requeued any `SUBMITTED` payments older than `STUCK_PAYMENT_THRESHOLD_MS`, before any workers start), then again from `transactionQueueService.startWorker` (after the BullMQ worker is created). The second call is **idempotent rather than a true no-op**: BullMQ rejects `Queue.add()` for jobs whose `jobId: txHash` is already present with `Job with that id already exists`, and the loop logs and continues. The net effect is identical to a single call but produces a handful of expected warn logs on every boot (one per job recovered in the first sweep).

1. Finds every `PendingVerification` doc with `status ∈ {pending, processing}` across all schools.
2. Resets any `processing` doc back to `pending` so a fresh worker takes over.
3. Re-adds the job to BullMQ. If BullMQ already holds the job (because its `jobId: txHash` was deduped), `Queue.add()` rejects with `Job with that id already exists`; the loop logs and continues, leaving both the MongoDB record and the existing BullMQ job intact.

**Graceful shutdown.** `shutdownManager.drainWorkers()` calls `transactionQueue.drainWorker()` which:

- Waits up to `DRAIN_TIMEOUT_MS` (default 60s) for in-flight jobs to finish.
- If the timeout is hit, marks any still-`active` job's `PendingVerification` as `pending` (via `markInterrupted`) with `lastError: 'Job interrupted by shutdown drain timeout — will be recovered on restart'`. Critically, this is **NOT** `dead_letter` — `dead_letter` is reserved for terminal failures from `markDead`. The drain-timeout job is re-processable, so the next startup's `recoverPendingJobs()` sweep picks it up and re-enqueues it.

**Test coverage.** `tests/transactionQueueDurability.test.js` (issue #388) and `tests/issue-800-queue-restart.test.js` (issue #800) verify the persistence-first contract, the recovery sweep, idempotent upsert on duplicate `txHash`, and `markResolved` / `markDead` semantics. The restart-mid-queue scenario ("no transaction submission is silently dropped after a process restart") is exercised by the new `'restart-mid-queue — no transaction is silently dropped (#1053)'` describe block in `tests/transactionQueueDurability.test.js`, which simulates restart by configuring the post-restart MongoDB state and verifying that `recoverPendingJobs()` re-enqueues the `txHash`-keyed job into BullMQ.

### Transaction retry + DLQ queue — `queue/transactionRetryQueue.js`

This queue exists **separately** from the transaction processing queue and serves a different purpose: it retries transaction verifications that failed due to transient errors (e.g. Horizon 429 / 5xx). It is initialised only when `retryServiceSelector.useBullMQ()` returns true (`REDIS_HOST` is configured).

- **Main retry queue** (`transaction-retry-queue`): custom exponential backoff with up to `MAX_RETRY_ATTEMPTS` retries, capped by `MAX_RETRY_DELAY_MS`. The BullMQ Worker is configured with explicit `lockDuration`, `stalledInterval`, and `maxStalledCount` so that jobs whose worker dies mid-flight are reclaimed automatically by BullMQ itself.
- **Dead-letter queue** (`transaction-dead-letter-queue`): terminal failures (`permanently_failed` errors from `retryContract.isPermanent`, or retry-exhaustion) are written here with the original job data, error code, and `failedAt` timestamp.

The retry service also writes a `PendingVerification` mirror record for cross-school queue stats, so MongoDB remains the system-wide source of truth for "was this tx ever retried".

**Difference from the transaction processing queue:** the retry worker uses BullMQ's built-in stalled-job reclaim (`lockDuration`, `stalledInterval`, `maxStalledCount`) for fast mid-flight recovery, while the transaction processing worker relies entirely on the MongoDB-backed `recoverPendingJobs()` sweep reconstituting the doc on restart. Both paths are durable; they are not the same recovery mechanism.

### Report generation queue — `queue/reportQueue.js`

Mirrors every job into the `ReportJob` collection with a monotonic lifecycle (`pending → processing → completed | failed`). The HTTP status endpoint reads the MongoDB record, not the BullMQ job state, so report status survives a queue restart.

### Summary

| Queue | In-memory only? | Lost on restart? | Cross-restart recovery path |
|---|---|---|---|
| Transaction processing (`transactionQueue.js`) | No | No | `recoverPendingJobs()` re-enqueues every `pending`/`processing` `PendingVerification` doc into BullMQ on every restart |
| Transaction retry + DLQ (`transactionRetryQueue.js`) | No | No | BullMQ persists jobs in Redis; permanent failures are durably written to the DLQ; mirror records in `PendingVerification` survive even a full Redis loss |
| Report generation (`reportQueue.js`) | No | No | `ReportJob` documents hold the authoritative state machine; `enqueueReportJob` re-creates the Document on every submission; report status queries read the MongoDB record |

Failure modes that *can* lose a transaction, with mitigations:

- **MongoDB write fails before BullMQ enqueue** — `enqueueTransaction` throws and the caller (typically `transactionQueueService.processTransactionJob` or `stuckPaymentReconciliation`) decides whether to retry. The error is logged with `correlationId` for triage.
- **MongoDB upsert succeeds, BullMQ add succeeds, but the worker crashes before `markResolved` is called** — `PendingVerification.status` is left in `processing`. The startup recovery sweep (`recoverPendingJobs`) resets it to `pending` and re-adds to BullMQ, so the job is reprocessed. Idempotency in `processTransactionJob` (the existing `Payment.findOne({ txHash })` skip) ensures double-processing is a no-op.
- **Redis backplane loses all data** (e.g. non-persistent Redis in dev) — `PendingVerification` documents with `status=pending|processing` are recovered on the next startup, even though BullMQ state was lost. The `'restart-mid-queue — no transaction is silently dropped (#1053)'` describe block in `tests/transactionQueueDurability.test.js` proves this flow.

---

## Multi-School Tenancy

Every document in MongoDB carries a `schoolId` field. The `schoolContext` middleware resolves the school from the `X-School-ID` or `X-School-Slug` request header and attaches it to `req.school`. All queries are scoped to `req.school.schoolId`.

Each school has its own `stellarAddress`. The transaction poller fans out to all active schools in parallel. There is no shared wallet.

---

## Error Handling and Resilience

- All Horizon API calls use `withStellarRetry` — exponential backoff with jitter, retries on transient network errors and HTTP 429/5xx.
- Transient failures during sync are queued as `PendingVerification` documents and retried by `retryService`.
- The `concurrentRequestHandler` middleware adds a circuit breaker (opens after 5 failures, resets after 30s) and a request queue (max 50 concurrent, max 1000 queued) to protect against Horizon API bursts.
- Idempotency keys prevent duplicate payment processing from retried HTTP requests.
- Graceful shutdown waits up to 8s for the retry worker to finish its current batch before closing the MongoDB connection.

---

## Money Representation on the Payment-Verification Path

`paymentController.verifyPayment` and the `studentBalanceUpdater` it shares with
`submitTransaction` decide whether a student's fee is settled — `valid`,
`partial`, or `overpaid` — and compute `excessAmount` / `remainingBalance`.
That decision used to run on IEEE-754 doubles: cumulative totals were summed
with MongoDB's `{ $sum: '$amount' }` (float addition, done server-side, order
not guaranteed), rounded with `toFixed(7)`, and re-parsed with `parseFloat`
before being compared against `feeAmount` with exact `<` / `>` / `===`.
`toFixed` cannot repair a value already corrupted by float addition, and
`parseFloat` immediately turns the rounded string back into a double —
reintroducing the same class of error on the next operation. A fee paid in
installments that summed, in exact decimal, to precisely the fee amount could
therefore land one unit-in-the-last-place away and be misclassified `partial`
or `overpaid` instead of `valid`.

**Chosen representation: `decimal.js`.** This was already the convention
elsewhere in the codebase (`paymentLimitsService.js`,
`currencyConversionService.js`, `feeAdjustmentEngine.js`,
`utils/paymentLimits.js` — see their "ROUNDING POLICY" comments), so extending
it to the verification path unifies on an existing pattern rather than adding
a fourth. Integer Stellar stroops (`utils/stellarAmount.js`, used by
`stellarService.js`) remain the right choice for on-chain amount parsing and
comparison, and are unaffected by this change.

`backend/src/utils/money.js` is the canonical entry point for this path:

- `toMoney(value)` / `decimalFromMongo(value)` — parse a JS value or a BSON
  `Decimal128` aggregation result into a `Decimal`.
- `classifyFeePayment(cumulativeTotal, feeAmount)` — the single place that
  decides `valid` / `partial` / `overpaid` and derives `excessAmount` /
  `remainingBalance`, all via exact `Decimal` comparison (`.cmp()`), never
  float `<`/`>`/`===`.
- `roundMoney(value)` / `toMoneyNumber(value)` — round to Stellar's 7 decimal
  places and convert to a plain `Number` **only at the output boundary**
  (the HTTP response or the Mongo write).

**Conversion boundaries:**

```
MongoDB (amount: Number)
      │  $group: { $sum: { $toDecimal: '$amount' } }   ← summed as Decimal128, exact
      ▼
Decimal128 (aggregation result)
      │  decimalFromMongo()
      ▼
Decimal (decimal.js) ── classifyFeePayment() ── all arithmetic and comparison here
      │  toMoneyNumber() / roundMoney().toNumber()
      ▼
Number  → HTTP response body / Student.totalPaid, remainingBalance, feePaid
```

The MongoDB half of the fix matters as much as the JS half: summing
`{ $sum: '$amount' }` accumulates BSON-double rounding **inside MongoDB**,
before the result ever reaches Node, so no amount of `decimal.js` downstream
can recover it. Wrapping the summed field in `$toDecimal` makes MongoDB
perform the addition in exact Decimal128 space instead.

`parseFloat(x.toFixed(7))` must not reappear anywhere on this path — it is a
reliable marker of float money arithmetic creeping back in.

---

## Content Security Policy (CSP) Strategy

CSP is enforced at two distinct layers, each appropriate to what it serves.

### Frontend (Next.js)

The browser-facing CSP is configured in `frontend/next.config.js` via the `headers()` function. It applies to every route (`/(.*)`):

| Directive | Value | Reason |
|-----------|-------|--------|
| `default-src` | `'self'` | Baseline: only same-origin resources |
| `script-src` | `'self'` | No inline scripts, no eval |
| `style-src` | `'self'` | No inline styles |
| `img-src` | `'self' data:` | Allows base64 data URIs for QR codes |
| `font-src` | `'self'` | Same-origin fonts only |
| `connect-src` | `'self' https://horizon-testnet.stellar.org https://horizon.stellar.org` | Allows fetch to the backend API and Stellar Horizon |
| `object-src` | `'none'` | Blocks Flash and plugins |
| `frame-ancestors` | `'none'` | Prevents clickjacking |
| `base-uri` | `'self'` | Prevents base tag injection |
| `form-action` | `'self'` | Restricts form submissions |

`'unsafe-inline'` and `'unsafe-eval'` are intentionally absent.

### Backend (Express / Helmet)

The backend serves only JSON API responses — it never renders HTML, loads scripts, or applies styles. HTML-oriented CSP directives (`scriptSrc`, `styleSrc`, `imgSrc`, etc.) are therefore meaningless here and have been removed.

The backend Helmet CSP is intentionally minimal:

```js
contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'none'"],   // deny everything by default
    frameAncestors: ["'none'"], // prevent embedding in iframes
  },
}
```

This follows the principle of least privilege: the backend declares that no browser should ever render its responses as a document.

---

## MongoDB Connection Configuration

Connection options are explicitly configured in `backend/src/config/database.js` for production durability and performance:

| Option | Value | Rationale |
|--------|-------|-----------|
| `maxPoolSize` | 20 (env: `MONGODB_POOL_SIZE`) | Limits sockets to prevent resource exhaustion under load; matches the `concurrentRequestHandler` queue maxConcurrent. |
| `minPoolSize` | 10 (env: `DB_MIN_POOL_SIZE`) | Keeps warm sockets ready for traffic bursts. |
| `maxIdleTimeMS` | 30000 | Reclaims idle connections after 30s to avoid stale connections. |
| `connectTimeoutMS` | 10000 | Fail fast on unreachable MongoDB. |
| `socketTimeoutMS` | 45000 | Prevent hung operations; should exceed typical query latency. |
| `serverSelectionTimeoutMS` | 5000 | Quick detection of replica set availability issues. |
| `w: 'majority'` | `majority` | Financial writes must be acknowledged by a majority of replica set members to survive failover. |
| `readPreference` | `primaryPreferred` | Always reads from primary for consistency; falls back to secondaries only if primary is unavailable. |
| `retryWrites` | `true` | Automatic retry of transient write failures. |
| `retryReads` | `true` | Automatic retry of transient read failures. |

### Write Concern for Financial Operations

Payment writes use explicit `{ w: 'majority', wtimeout: 5000 }` to ensure:
- Durability across replica set failover
- Acknowledgement latency bounded by timeout (prevents indefinite hangs)

This is applied in `transactionService.js` for `Payment.create()` and `Outbox.create()` operations.

### Load Testing Pool Sizing

The `tests/mongoPoolSizing.test.js` validates that the connection pool handles concurrent operations correctly without exhaustion. Run with:

```bash
npm test -- tests/mongoPoolSizing.test.js
```
