# StellarEduPay — GitHub Issues

---

## Issue #1: `syncAllPayments` calls `syncPaymentsForSchool` twice and sends two HTTP responses

> **STATUS: RESOLVED (fixed before this document was compiled).** This entry derives from the `issues.md` audit dated 2026-05-26, one day before the fix landed in `fix/559-560-561-562` (see `IMPLEMENTATION_SUMMARY.md`, 2026-05-27). Current code (`backend/src/controllers/paymentAdminController.js`) calls `syncPaymentsForSchool` and `res.json` exactly once. Independently re-confirmed by `CHANGELOG.md` issue #731. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `bug`, `critical`, `backend`

### Problem

In `backend/src/controllers/paymentController.js`, the `syncAllPayments` handler contains a logic error that causes two serious problems simultaneously. First, `syncPaymentsForSchool(req.school)` is called **twice** — once before `res.json(...)` and once after. The second call runs after the HTTP response has already been sent, meaning its result is silently discarded and any errors it throws are unhandled. Second, `res.json(...)` is called **twice** — the first call sends the response with the first sync's summary, and the second call attempts to send another response on an already-closed socket.

In Express this produces a `Cannot set headers after they are sent` error that pollutes logs and can crash the process in some configurations. Every manual sync triggers two full blockchain polling cycles, doubling Horizon API usage and MongoDB writes. Duplicate payment records may be created if the idempotency check has a race window. The audit log captures the result of the second (redundant) sync, not the one whose summary was returned to the caller.

### Proposed Fix

Remove the duplicate `syncPaymentsForSchool` call and the duplicate `res.json` call. The function should call the service once, log the audit, and send one response.

```js
async function syncAllPayments(req, res, next) {
  const schoolId = req.schoolId;
  if (_syncLocks.has(schoolId)) {
    return res.status(409).json({ error: "Sync already in progress", code: "SYNC_IN_PROGRESS" });
  }
  _syncLocks.add(schoolId);
  try {
    const summary = await syncPaymentsForSchool(req.school);
    if (req.auditContext) {
      await logAudit({ schoolId, action: 'payment_manual_sync', details: { syncResult: summary }, result: 'success' });
    }
    res.json({ message: "Sync complete", summary });
  } catch (err) {
    next(wrapStellarError(err));
  } finally {
    _syncLocks.delete(schoolId);
  }
}
```

### Acceptance Criteria

- [ ] `syncPaymentsForSchool` is called exactly once per `POST /api/payments/sync` request.
- [ ] `res.json` is called exactly once per request; no "headers already sent" errors appear in logs.
- [ ] The audit log entry captures the summary from the single sync call.
- [ ] The in-memory `_syncLocks` set is always cleaned up in the `finally` block.
- [ ] A new unit test asserts that `syncPaymentsForSchool` is called exactly once when `POST /api/payments/sync` is invoked.

---

## Issue #2: `GET /api/payments/:studentId` lacks cross-school isolation tests

> **STATUS: RESOLVED (fixed before this document was compiled).** This entry derives from the `issues.md` audit dated 2026-05-26, before the fix in `IMPLEMENTATION_SUMMARY.md` (2026-05-27, issue #561) landed. Current code (`backend/src/controllers/paymentQueryController.js`) scopes the student lookup, payment find/count, and both balance aggregations by `schoolId`. `tests/cross-school-isolation.test.js` and `backend/tests/cross-school-isolation.test.js` exist and are substantial. Note: the separate, still-open issue is that `resolveSchool` trusts the `X-School-ID`/`X-School-Slug` header alone on read endpoints when no JWT is present — a different problem from this one. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `bug`, `security`, `multi-school`

### Problem

`getStudentPayments` in `paymentController.js` queries payments using both `schoolId` and `studentId`. However, `studentId` values are not globally unique — they are only unique within a school (enforced by the compound index `{ studentId: 1, schoolId: 1 }`). If two schools both have a student with ID `STU001`, the `schoolId` filter should prevent data leakage, but there are no integration tests that verify this isolation.

Without cross-school isolation tests, any future refactor that accidentally drops the `schoolId` filter from a query will not be caught by CI. The `getStudentBalance` endpoint performs aggregations that must also be scoped to `schoolId`, and the `getPaymentInstructions` endpoint must return the correct school's wallet address. All of these are untested for cross-school scenarios.

The root issue is that there is no integration test covering cross-school payment isolation, making this class of bug invisible to the CI pipeline.

### Proposed Fix

Add integration tests that create two schools with overlapping `studentId` values and assert that each school only sees its own data. Add a middleware-level guard that rejects requests where `req.schoolId` is absent.

### Acceptance Criteria

- [ ] `GET /api/payments/:studentId` returns `404` when the student exists in a different school than the one in the request context.
- [ ] `GET /api/payments/:studentId/balance` returns `404` under the same condition.
- [ ] A test suite `tests/cross-school-isolation.test.js` is added with at least 5 test cases.
- [ ] All existing payment tests continue to pass.
- [ ] The `resolveSchool` middleware is applied to every payment and student route.

---

## Issue #3: `schoolModel.js` missing `timezone` field causes incorrect date grouping in reports

**Labels:** `enhancement`, `multi-school`, `feature`

### Problem

The `School` model (`backend/src/models/schoolModel.js`) stores a `localCurrency` field for fiat conversion but has no `timezone` field. All timestamps are stored and returned in UTC. The `aggregateByDate` function in `reportService.js` groups payments by `$dateToString` using the default UTC timezone. A school in UTC+10 (e.g. Papua New Guinea) will see payments made at 11 PM local time grouped under the wrong date.

Payment deadlines stored as UTC `Date` objects are displayed without timezone context, which is confusing for parents. The dashboard "today's payments" metric uses `new Date()` (server UTC) as the start of today, which is wrong for schools in different timezones. Reminder scheduling in `reminderService.js` runs on a fixed UTC interval with no awareness of school business hours.

### Proposed Fix

Add a `timezone` field (IANA string, default `'UTC'`) to the `School` model. Use it in `reportService.aggregateByDate` via MongoDB's `$dateToString` `timezone` option, in `getDashboardMetrics` for computing start-of-day, and in all API responses that include timestamps.

### Acceptance Criteria

- [ ] `School` model has a `timezone` field (String, default `'UTC'`, validated as a valid IANA timezone identifier).
- [ ] `POST /api/schools` and `PATCH /api/schools/:slug` accept and persist a `timezone` value; invalid values return `400`.
- [ ] `reportService.aggregateByDate` passes the school's `timezone` to MongoDB's `$dateToString`.
- [ ] `reportService.getDashboardMetrics` computes "start of today" using the school's timezone.
- [ ] A migration script backfills `timezone: 'UTC'` for all existing schools.

---

## Issue #4: Payment memo is encrypted before being sent to parents — breaks Stellar memo 28-byte limit

**Labels:** `bug`, `critical`, `stellar-integration`

### Problem

`getPaymentInstructions` in `paymentController.js` returns an encrypted memo to the client via `encryptMemo(req.params.studentId)`. When `MEMO_ENCRYPTION_KEY` is set, `encryptMemo` returns an AES-256-GCM ciphertext string. Stellar `MEMO_TEXT` is limited to **28 bytes**. An AES-GCM ciphertext (IV + tag + ciphertext, hex-encoded) is typically 80–100 characters — far exceeding the limit. The Stellar SDK will throw `MemoTooLongError` when the parent's wallet tries to build the transaction.

Even if the memo were short enough, `extractValidPayment` in `stellarService.js` reads `tx.memo` from the blockchain and passes it to `decryptMemo` before matching it to a student. But the memo on-chain is the encrypted string the parent copied — it was never the raw student ID. The decryption will fail and no student will ever be matched. With `MEMO_ENCRYPTION_KEY` set, the entire payment flow is silently broken.

### Proposed Fix

`getPaymentInstructions` must return the plain-text student ID as the memo. Encryption at rest is handled by the `paymentModel` pre-save hook and must not affect what is shown to the user.

```js
res.json({
  memo: req.params.studentId,  // always plain text
  ...
});
```

### Acceptance Criteria

- [ ] `GET /api/payments/instructions/:studentId` returns `memo` equal to the plain-text `studentId` regardless of `MEMO_ENCRYPTION_KEY`.
- [ ] `POST /api/payments/intent` stores the plain-text random memo; encryption only happens via the model pre-save hook.
- [ ] The `memoEncrypted` field is removed from the payment instructions response.
- [ ] A test asserts that with `MEMO_ENCRYPTION_KEY` set, the instructions endpoint returns a plain-text memo ≤ 28 bytes.
- [ ] End-to-end payment flow test passes with encryption enabled.

---

## Issue #5: Write endpoints for students, fees, and schools have no authentication

> **STATUS: RESOLVED (fixed before this document was compiled).** This entry derives from the `issues.md` audit dated 2026-05-26, before the fix in `IMPLEMENTATION_SUMMARY.md` (2026-05-27, issue #562) landed. Every endpoint listed below now has `requireAdminAuth` applied in its route file. `tests/authentication-enforcement.test.js` exists and is substantial. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `security`, `critical`, `backend`

### Problem

The `requireAdminAuth` middleware exists in `backend/src/middleware/auth.js` but is not applied to high-privilege write endpoints. Any unauthenticated actor can call `POST /api/students`, `PUT /api/fees/:className`, `PATCH /api/schools/:slug`, `POST /api/payments/sync`, and `PATCH /api/payments/:txHash/status` without any credentials.

An attacker can change a school's `stellarAddress` to redirect all future payment instructions to an attacker-controlled wallet, delete all students causing historical payments to be orphaned, or trigger unlimited blockchain syncs exhausting Horizon API rate limits. The `updatePaymentStatus` endpoint allows marking payments as `DISPUTED` — without auth, anyone can dispute any payment.

### Proposed Fix

Apply `requireAdminAuth` to all write endpoints for students, fees, schools, and payment management.

```js
router.post('/', requireAdminAuth, registerStudent);
router.put('/:id', requireAdminAuth, updateStudent);
router.delete('/:id', requireAdminAuth, deleteStudent);
```

### Acceptance Criteria

- [ ] `POST /api/students`, `PUT /api/students/:id`, `DELETE /api/students/:id` require a valid admin JWT; unauthenticated requests return `401`.
- [ ] `POST /api/fees`, `PUT /api/fees/:className`, `DELETE /api/fees/:className` require a valid admin JWT.
- [ ] `POST /api/schools`, `PATCH /api/schools/:slug`, `DELETE /api/schools/:slug` require a valid admin JWT.
- [ ] `POST /api/payments/sync` and `PATCH /api/payments/:txHash/status` require a valid admin JWT.
- [ ] New tests assert that each protected endpoint returns `401` without a token and `403` with a non-admin token.

---

## Issue #6: `deleteStudent` performs a hard delete — student record and payment history are permanently lost

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

`deleteStudent` in `studentController.js` calls `Student.findOneAndDelete(...)`, permanently removing the student document from MongoDB. The `studentModel` has a `deletedAt` field and the `softDelete` utility is applied to the schema, meaning soft-delete support is already built in — but the delete controller bypasses it entirely.

Consequences include: the student's name, class, and fee history are permanently gone with no recovery path; payments are marked `studentDeleted: true` and excluded from reports, but the payment records still exist with a `studentId` that no longer resolves to a student document; audit logs reference the deleted `studentId` but the student document is gone; if a new student is registered with the same `studentId`, their payment history will be contaminated by orphaned payments from the previous student.

### Proposed Fix

Replace the hard delete with a soft delete using the existing utility:

```js
const student = await Student.findOneAndUpdate(
  { schoolId: req.schoolId, studentId },
  { deletedAt: new Date() },
  { new: true }
);
```

### Acceptance Criteria

- [ ] `DELETE /api/students/:studentId` sets `deletedAt` to the current timestamp instead of removing the document.
- [ ] Soft-deleted students do not appear in `GET /api/students` responses.
- [ ] `GET /api/students/:studentId` returns `404` for soft-deleted students.
- [ ] Attempting to register a new student with the same `studentId` as a soft-deleted student returns `409`.
- [ ] Unit tests cover soft-delete, re-registration prevention, and exclusion from listings.

---

## Issue #7: Currency conversion has no stale-cache fallback when CoinGecko is unavailable

**Labels:** `enhancement`, `reliability`, `backend`

### Problem

`currencyConversionService.js` fetches live XLM/USDC prices from CoinGecko. When CoinGecko is unavailable, the in-memory cache expires after `PRICE_CACHE_TTL_MS` (default 60 seconds) and all subsequent requests return `available: false` with null fiat fields — even though a 5-minute-old rate would be far more useful than nothing.

On server restart the cache is empty. If CoinGecko is down at startup, the first N requests all hit the API simultaneously. The `/health` endpoint does not report price feed status, so operators have no visibility into price feed outages. The `getExchangeRates` endpoint returns `available: false` with no indication of when rates were last successfully fetched.

### Proposed Fix

Implement stale-while-revalidate: keep the last successful rate in memory indefinitely. When a fresh fetch fails, return the stale rate with `stale: true` and `staleAge` (seconds since last fetch). Add `PRICE_STALE_THRESHOLD_MS` env var (default: 1 hour) beyond which stale rates are not used.

### Acceptance Criteria

- [ ] When CoinGecko returns an error, `convertToLocalCurrency` returns the last successfully fetched rate with `stale: true` if within `PRICE_STALE_THRESHOLD_MS`.
- [ ] When the cached rate is older than `PRICE_STALE_THRESHOLD_MS`, `convertToLocalCurrency` returns `available: false`.
- [ ] `GET /api/payments/rates` response includes `lastFetchedAt`, `stale`, and `staleAge` fields.
- [ ] `GET /health` includes a `priceFeed` subsystem with `available`, `lastFetchedAt`, and `staleAge`.
- [ ] Existing `tests/currencyConversion.test.js` tests continue to pass.

---

## Issue #8: Bulk student import processes rows sequentially — times out for large CSV files

**Labels:** `performance`, `backend`

### Problem

`bulkImportStudents` in `studentController.js` processes CSV rows in a `for` loop with `await` inside, making it fully sequential. For a 10,000-row CSV (the configured maximum), this means 10,000 sequential round-trips to MongoDB. On a typical Atlas cluster with 5 ms round-trip latency, this takes 50 seconds — well beyond the default 30-second HTTP timeout in most reverse proxies.

The fee structure lookup (`FeeStructure.findOne`) is also inside the loop, causing up to 10,000 additional sequential queries even when all students are in the same class. There is no progress reporting — the client receives no feedback until all rows are processed or the request times out. If the request times out, partial imports leave the database in an inconsistent state.

### Proposed Fix

Pre-fetch fee structures for all unique class names before the loop. Use `Student.insertMany` with `ordered: false` for batch inserts. Process rows in chunks of 500.

### Acceptance Criteria

- [ ] Bulk import of 1,000 students completes in under 5 seconds.
- [ ] Fee structures are fetched once per unique class name, not once per row.
- [ ] `Student.insertMany` is used instead of per-row `Student.create`.
- [ ] Individual row failures are reported in the response `details` array without aborting the entire import.
- [ ] Existing `tests/csvImportLimits.test.js` tests continue to pass.

---

## Issue #9: `reminderService` exposes no API endpoint for parents to opt out of reminder emails

**Labels:** `feature`, `compliance`, `backend`

### Problem

The `Student` model has a `reminderOptOut` boolean field and `reminderService.isEligible` checks it, but there is no API endpoint that allows a parent to set `reminderOptOut: true`. The `updateStudent` controller does not include `reminderOptOut` in its allowed update fields. In jurisdictions with anti-spam laws (CAN-SPAM, GDPR), the inability to unsubscribe from automated emails is a compliance violation.

School administrators cannot opt out a parent through the normal API either. The only path is direct database manipulation. The reminder email templates in `backend/src/templates/reminderEmail.html` and `reminderEmail.txt` do not include an unsubscribe link.

### Proposed Fix

Add `reminderOptOut` to the allowed fields in `updateStudent`. Include a signed unsubscribe token in reminder emails. Add a public endpoint `GET /api/reminders/unsubscribe?token=<signed-token>` that sets `reminderOptOut: true` without requiring authentication.

### Acceptance Criteria

- [ ] `PATCH /api/students/:studentId` accepts `reminderOptOut: true/false` and persists it.
- [ ] Reminder emails include an unsubscribe link containing a signed token.
- [ ] `GET /api/reminders/unsubscribe?token=<token>` sets `reminderOptOut: true` for the identified student.
- [ ] Expired or invalid unsubscribe tokens return `400` with a clear error message.
- [ ] The reminder email templates are updated to include the unsubscribe link.

---

## Issue #10: Webhook delivery has no replay protection — intercepted webhooks can be replayed indefinitely

**Labels:** `security`, `backend`, `webhooks`

### Problem

`webhookService.js` signs outbound webhook payloads with HMAC-SHA256 but the signature covers only the payload content, not a timestamp or nonce. An attacker who intercepts a legitimate webhook delivery can replay it at any time — the signature will still be valid because the payload has not changed. Recipient systems that verify the signature but do not check for replay attacks will process the same payment event multiple times.

There is no `X-Webhook-Delivery-ID` header, so recipients cannot use delivery IDs to deduplicate. This is a well-known vulnerability addressed by GitHub, Stripe, and other major platforms by including a timestamp in the signed payload.

### Proposed Fix

Add `X-StellarEduPay-Timestamp` (Unix seconds) and `X-StellarEduPay-Delivery-ID` (UUID) headers. Include the timestamp in the HMAC input: `HMAC(timestamp + "." + JSON.stringify(body))`. Document that recipients should reject deliveries where `|now - timestamp| > 300` seconds.

### Acceptance Criteria

- [ ] Every webhook delivery includes `X-StellarEduPay-Timestamp` and `X-StellarEduPay-Delivery-ID` headers.
- [ ] The HMAC signature is computed over `timestamp + "." + JSON.stringify(body)`.
- [ ] `verifySignature` validates both the HMAC and that `|now - timestamp| <= 300` seconds.
- [ ] Retry attempts use the same `deliveryId` as the original delivery.
- [ ] `docs/WEBHOOK_INTEGRATION.md` is updated with the new signature format and replay window guidance.

---

## Issue #11: In-memory transaction queue is lost on server restart — submitted transactions stuck in SUBMITTED status

**Labels:** `bug`, `reliability`, `backend`

### Problem

`backend/src/queue/transactionQueue.js` implements an in-memory queue for processing submitted Stellar transactions. When the server restarts (deployment, crash, OOM kill), all jobs in the queue are lost. Any transaction that was submitted to the Stellar network but not yet verified will never be verified, and the associated payment record will remain in `SUBMITTED` status indefinitely.

The `transactionRetryQueue.js` uses BullMQ (Redis-backed) for the retry queue, which is durable. But the primary transaction queue is in-memory only. There is no background job that scans for payments stuck in `SUBMITTED` status and re-queues them for verification. A payment can be stuck in `SUBMITTED` forever if the server restarts between submission and verification.

### Proposed Fix

Back the transaction queue with Redis using BullMQ (already a dependency). Add a startup reconciliation job that finds all payments in `SUBMITTED` status older than 5 minutes and re-queues them. Add `GET /api/payments/stuck` (admin-only) to list stuck payments.

### Acceptance Criteria

- [ ] The transaction queue is backed by Redis (BullMQ) when `REDIS_HOST` is configured; falls back to in-memory with a startup warning.
- [ ] On server startup, payments in `SUBMITTED` status older than `STUCK_PAYMENT_THRESHOLD_MS` are automatically re-queued.
- [ ] `GET /api/payments/stuck` (admin-only) returns payments in `SUBMITTED` status older than the threshold.
- [ ] The startup reconciliation job is logged at `info` level with the count of re-queued payments.
- [ ] Existing `tests/transactionQueueDurability.test.js` tests are updated to cover the new behavior.

---

## Issue #12: Soft-deleted payments appear in `GET /api/payments` responses

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

`getAllPayments` in `paymentController.js` filters out payments where `studentDeleted: true` but does not filter out payments where `deletedAt` is set. The `Payment` model has a `deletedAt` field and the `softDelete` utility is applied to the schema, but the explicit filter object passed to `Payment.find(filter)` does not include `deletedAt: null`.

The `softDelete` utility adds a query middleware hook that appends `{ deletedAt: null }` to `find` queries, but this may not apply correctly when an explicit filter object is provided depending on Mongoose version. `getStudentPayments` and `getStudentBalance` also do not explicitly filter `deletedAt: null`, relying entirely on the middleware hook.

### Proposed Fix

Explicitly add `deletedAt: null` to all payment query filters in `getAllPayments`, `getStudentPayments`, `getStudentBalance`, `getOverpayments`, `getSuspiciousPayments`, `getPendingPayments`, and all report aggregations.

### Acceptance Criteria

- [ ] `GET /api/payments` does not return payments where `deletedAt` is set.
- [ ] `GET /api/payments/:studentId` does not return soft-deleted payments.
- [ ] `GET /api/payments/:studentId/balance` excludes soft-deleted payments from the total paid calculation.
- [ ] Report aggregations in `reportService.js` exclude soft-deleted payments.
- [ ] A test creates a payment, soft-deletes it, and asserts it does not appear in any of the above endpoints.

---

## Issue #13: No rate limiting on `POST /api/students/bulk` — enables denial-of-service via large CSV uploads

**Labels:** `security`, `backend`, `rate-limiting`

### Problem

`POST /api/students/bulk` accepts CSV files up to 5 MB with up to 10,000 rows. The endpoint is subject only to the general rate limiter (100 requests per 15 minutes). An attacker can upload 100 × 10,000-row CSVs in 15 minutes, triggering up to 1,000,000 sequential MongoDB queries. The CSV parsing itself is CPU-intensive for large files; 100 concurrent large uploads can exhaust Node.js's single-threaded event loop.

Additionally, there is no authentication on this endpoint (see Issue #5), so the attack requires no credentials. The file size validation runs before parsing, but there is no per-IP rate limit specific to this expensive endpoint.

### Proposed Fix

Add a dedicated rate limiter for bulk import (maximum 5 requests per hour per IP). Require admin authentication. Process files with more than 500 rows asynchronously (return `202 Accepted` with a job ID).

### Acceptance Criteria

- [ ] `POST /api/students/bulk` is protected by a dedicated rate limiter: maximum 5 requests per hour per IP.
- [ ] Requests exceeding the rate limit return `429` with `code: RATE_LIMIT_EXCEEDED`.
- [ ] The endpoint requires admin authentication.
- [ ] File size is validated before the CSV stream is opened.
- [ ] A test asserts that the 6th bulk import request within an hour returns `429`.

---

## Issue #14: Fee cascade update sets `remainingBalance: null` instead of recalculating per student

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

When `PUT /api/fees/:className` is called with `cascadeToStudents: true`, the controller runs `Student.updateMany(..., { feeAmount, remainingBalance: null })`. Setting `remainingBalance: null` is incorrect — it should be recalculated as `feeAmount - totalPaid` for each student. Setting it to `null` means `GET /api/students/:studentId` returns `remainingBalance: null` until the student's next payment.

The `feePaid` flag is also not updated by the cascade. A student who had fully paid the old fee amount may now be marked as unpaid after a fee increase, or vice versa. The `isOverdue` virtual depends on `feePaid`, so overdue calculations will also be wrong.

### Proposed Fix

Replace `updateMany` with per-student updates that recalculate `remainingBalance` and `feePaid`. Process in batches of 500 to avoid memory issues for large classes.

### Acceptance Criteria

- [ ] After cascade update, all students in the class have correct `feeAmount`, `remainingBalance`, and `feePaid` values.
- [ ] A student who had `totalPaid >= oldFeeAmount` and `newFeeAmount > oldFeeAmount` has `feePaid: false` after the cascade.
- [ ] `remainingBalance` is never `null` after a cascade update.
- [ ] The cascade is performed in batches of 500 students.
- [ ] Unit tests cover fee increase, fee decrease, and no-change scenarios.

---

## Issue #15: Health check endpoint does not verify Stellar Horizon connectivity

**Labels:** `enhancement`, `observability`, `backend`

### Problem

`GET /health` does not verify Stellar Horizon connectivity. If the Horizon API is unreachable, the health endpoint still returns `200 ok` even though `POST /api/payments/verify` will fail for all new transactions, `POST /api/payments/sync` will fail, and background polling will silently stop matching payments. Load balancers and uptime monitors will not detect a Stellar outage, and the system will appear healthy while payments are not being processed.

The README documents that `GET /health` should return `200 { status: "degraded" }` when a subsystem is unreachable, but the Stellar subsystem is not checked.

### Proposed Fix

Add a Stellar Horizon connectivity check with a 3-second timeout and no retries. If Stellar is unreachable, return `200 { status: "degraded", details: { stellar: { status: "unreachable" } } }`.

### Acceptance Criteria

- [ ] `GET /health` includes a `stellar` subsystem in the response.
- [ ] When Stellar Horizon is unreachable, `GET /health` returns `200` with `status: "degraded"`.
- [ ] The Stellar health check has a maximum timeout of 3 seconds and does not retry.
- [ ] `GET /health` response time is under 5 seconds even when Stellar is unreachable.
- [ ] Unit tests in `tests/health.test.js` cover all healthy, Stellar unreachable, and MongoDB disconnected scenarios.

---

## Issue #16: Audit log endpoint has no pagination — causes memory exhaustion for large audit logs

**Labels:** `performance`, `backend`, `observability`

### Problem

`GET /api/audit-logs` in `auditController.js` fetches audit log entries without pagination, returning all matching records in a single response. A busy school with many payment verifications can accumulate thousands of audit log entries per day. Fetching all of them in one request loads the entire result set into Node.js memory before serializing to JSON.

The frontend `audit-logs.jsx` page loads all audit logs at once, which can cause the browser to freeze for large datasets. The `.kiro/specs/audit-log-pagination/` spec directory exists, indicating this was planned but not implemented.

### Proposed Fix

Implement offset-based pagination consistent with `getAllPayments` and `getStudentPayments`. Support filtering by `action`, `startDate`, `endDate`, `result`, and `performedBy`.

### Acceptance Criteria

- [ ] `GET /api/audit-logs` supports `page` (default 1) and `limit` (default 50, max 200) query parameters.
- [ ] The response includes a `pagination` object with `page`, `limit`, `total`, and `totalPages`.
- [ ] The endpoint never loads more than `limit` documents into memory at once.
- [ ] The frontend `audit-logs.jsx` page is updated to use paginated loading.
- [ ] The `.kiro/specs/audit-log-pagination/tasks.md` tasks are completed.

---

## Issue #17: `paymentModel` pre-save hook blocks `SUCCESS → DISPUTED` transition needed by admin override

**Labels:** `bug`, `backend`

### Problem

The `paymentModel` pre-save hook enforces immutability for payments in `SUCCESS` or `FAILED` status. However, `updatePaymentStatus` in `paymentController.js` allows the transition `SUCCESS → DISPUTED`. The controller uses `findOneAndUpdate` (not `save`), which bypasses Mongoose pre-save hooks — so the transition currently works, but only because it bypasses the hook. Any future refactor that switches to `save()` will silently break admin dispute flagging.

The two mechanisms (pre-save hook and `ALLOWED_TRANSITIONS`) are inconsistent and their interaction is not documented. The `FAILED → SUCCESS` transition is blocked by both, but for different reasons.

### Proposed Fix

Remove the blanket immutability check from the pre-save hook. Enforce immutability at the controller/service layer where business rules are defined. Add an explicit exception for `SUCCESS → DISPUTED` or document the bypass.

### Acceptance Criteria

- [ ] `PATCH /api/payments/:txHash/status` with `{ status: "DISPUTED" }` on a `SUCCESS` payment succeeds.
- [ ] `PATCH /api/payments/:txHash/status` with an invalid transition returns `400 INVALID_TRANSITION`.
- [ ] The pre-save hook and `ALLOWED_TRANSITIONS` enforce the same rules.
- [ ] A unit test covers the `SUCCESS → DISPUTED` transition via both `findOneAndUpdate` and `save()`.
- [ ] Existing `tests/updatePaymentStatus.test.js` tests continue to pass.

---

## Issue #18: `generateStudentId` has no retry loop — ID collisions surface as unexpected 409 errors

**Labels:** `bug`, `backend`

### Problem

`backend/src/utils/generateStudentId.js` generates a student ID when `studentId` is not provided in the registration request. The function generates a random ID but does not check for uniqueness or retry on collision. If the generated ID collides with an existing one, `registerStudent` throws a `11000` duplicate key error, which is caught and returned as `409 DUPLICATE_STUDENT` — but the caller asked for an auto-generated ID, so they have no way to resolve this without retrying the entire registration.

The collision probability increases as the number of students grows. With a short ID format, collisions become likely at a few thousand students.

### Proposed Fix

Add a retry loop in `generateStudentId` that checks for existence and regenerates if a collision is detected (up to 5 attempts). Use a higher-entropy ID format. Ensure the generated ID is ≤ 28 characters (Stellar memo limit).

### Acceptance Criteria

- [ ] `generateStudentId` retries up to 5 times if the generated ID already exists in the school.
- [ ] After 5 failed attempts, it throws `STUDENT_ID_GENERATION_FAILED`.
- [ ] The generated ID is ≤ 28 characters.
- [ ] Unit tests cover successful generation, single collision with retry, and exhausted retries.
- [ ] Existing `tests/generateStudentId.test.js` tests continue to pass.

---

## Issue #19: Frontend dashboard fetches all students without pagination — freezes for large schools

**Labels:** `performance`, `frontend`

### Problem

`frontend/src/pages/dashboard.jsx` fetches the student list from `GET /api/students`. The backend supports pagination but the frontend does not use it — it fetches all students in a single request. For schools with hundreds of students, the dashboard either shows only the first 50 students with no indication that more exist (silent data truncation), or loads all students into memory causing browser jank.

The dashboard's payment summary table computes the summary client-side from all students and payments, which is an O(n) memory operation that degrades as the school grows.

### Proposed Fix

Paginate the student list (20 per page). Add search and filter controls using the backend's existing `?search=`, `?class=`, `?status=` filters. Use the server-side `getPaymentSummary` endpoint instead of computing client-side.

### Acceptance Criteria

- [ ] The dashboard student list is paginated: 20 students per page with page navigation controls.
- [ ] The dashboard shows the total student count and current page range.
- [ ] Search by name or student ID is supported.
- [ ] Filter by payment status and class is supported.
- [ ] Page navigation is accessible (keyboard-navigable, ARIA labels).

---

## Issue #20: No end-to-end test covers the full payment flow from intent creation to blockchain sync

**Labels:** `testing`, `quality`

### Problem

The test suite has separate unit tests for individual components but no single test that exercises the complete payment flow: create school and student → create payment intent → submit transaction → verify transaction hash → confirm payment recorded → sync from blockchain → assert student `feePaid` updated. Without a full end-to-end test, regressions in the payment flow (like the double-sync bug or memo encryption bug) can be introduced without any test failing.

`tests/e2e-payment-flow.test.js` exists but may not cover all steps, particularly the sync flow and the interaction between `PaymentIntent`, `Payment`, and `Student` models.

### Proposed Fix

Write a comprehensive end-to-end test using in-memory MongoDB and mocked Stellar SDK covering all 7 steps and edge cases: overpayment, underpayment, duplicate transaction, expired payment intent, missing memo.

### Acceptance Criteria

- [ ] The test covers exact payment, overpayment, underpayment, duplicate tx, missing memo, expired intent, and sync flow.
- [ ] All tests use mocked Stellar SDK — no real network calls.
- [ ] Tests run in under 30 seconds total.
- [ ] The test file is included in the CI workflow.
- [ ] All existing tests continue to pass.

---

## Issue #21: Missing compound index on `payments` collection for `schoolId + status + confirmedAt` causes slow report queries

**Labels:** `performance`, `backend`, `database`

### Problem

`reportService.js` runs several aggregation pipelines that filter by `{ schoolId, status: 'SUCCESS', studentDeleted: { $ne: true } }` and sort by `confirmedAt`. The `paymentModel.js` defines individual indexes on `schoolId`, `status`, and `confirmedAt` separately, but MongoDB can only use one index per query stage. Without a compound index covering all three fields, MongoDB must perform a collection scan or use a partial index and then filter in memory.

For a school with 50,000 payment records, the `generateReport` and `getDashboardMetrics` functions can take several seconds. The `aggregateByDate` pipeline groups by date and sorts — without the right index, MongoDB cannot use an index scan for the sort stage and must sort the entire filtered result set in memory.

The existing indexes in `paymentModel.js` include `{ schoolId: 1, confirmedAt: -1 }` and `{ schoolId: 1, status: 1, confirmedAt: -1 }`, but the report queries also filter `studentDeleted: { $ne: true }` which is not covered by any compound index.

### Proposed Fix

Add a partial index that covers the most common report query pattern:

```js
paymentSchema.index(
  { schoolId: 1, status: 1, confirmedAt: -1 },
  { partialFilterExpression: { studentDeleted: { $ne: true }, deletedAt: null } }
);
```

Add a migration script to create this index on existing collections.

### Acceptance Criteria

- [ ] A compound index `{ schoolId: 1, status: 1, confirmedAt: -1 }` with a partial filter expression for `studentDeleted` and `deletedAt` is added to `paymentModel.js`.
- [ ] A migration script `backend/migrations/013_add_payment_report_index.js` creates the index on existing collections.
- [ ] `EXPLAIN` output for `generateReport` shows the new index being used (verified in a test or documented).
- [ ] Report generation time for 10,000 payments is under 500 ms (measured in a benchmark test).
- [ ] Existing tests continue to pass.

---

## Issue #22: `reportService.reportToCsv` does not escape commas or quotes in field values — produces malformed CSV

**Labels:** `bug`, `backend`

### Problem

`reportService.js` implements `reportToCsv` by joining field values with commas:

```js
lines.push([row.date, row.totalAmount, row.paymentCount, ...].join(','));
```

If any field value contains a comma (e.g. a class name like `"Grade 5, Advanced"`) or a double-quote, the resulting CSV will be malformed. Most CSV parsers will misinterpret the row, splitting it at the embedded comma and producing incorrect column alignment.

The summary section also concatenates values directly: `lines.push(`Generated At,${report.generatedAt}`)`. If `generatedAt` contained a comma (it doesn't currently, but the pattern is fragile), it would break. School names and class names are user-supplied strings that can contain any characters.

### Proposed Fix

Implement proper CSV escaping: wrap each field in double quotes and escape internal double quotes by doubling them.

```js
function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
```

### Acceptance Criteria

- [ ] `reportToCsv` wraps field values containing commas, quotes, or newlines in double quotes.
- [ ] Internal double quotes are escaped by doubling (`"` → `""`).
- [ ] A test asserts that a class name containing a comma produces a valid CSV row.
- [ ] A test asserts that a school name containing a double quote produces a valid CSV row.
- [ ] The CSV output can be parsed by standard CSV parsers (Node.js `csv-parser`, Excel, Google Sheets).

---

## Issue #23: `POST /api/payments/verify` does not validate that `txHash` is present in the request body before processing

**Labels:** `bug`, `backend`

### Problem

`verifyPayment` in `paymentController.js` calls `validateTransactionHash(txHash)` where `txHash` comes from `req.body.txHash`. If the request body is empty or `txHash` is missing, `txHash` is `undefined`. `validateTransactionHash(undefined)` may return `{ valid: false }` with a generic error, but the error message will be confusing ("undefined is not a valid transaction hash") rather than the clear "txHash is required" message that would help the caller.

Additionally, the audit log entry for a failed validation attempt uses `req.body?.txHash || 'unknown'` as the `targetId`, which means failed attempts with missing `txHash` are logged with `targetId: 'unknown'` — making it impossible to correlate audit log entries with specific requests.

### Proposed Fix

Add an explicit presence check before calling `validateTransactionHash`:

```js
if (!req.body.txHash) {
  return res.status(400).json({ error: 'txHash is required', code: 'VALIDATION_ERROR' });
}
```

### Acceptance Criteria

- [ ] `POST /api/payments/verify` with a missing `txHash` returns `400` with `code: VALIDATION_ERROR` and message `txHash is required`.
- [ ] `POST /api/payments/verify` with `txHash: null` returns the same error.
- [ ] `POST /api/payments/verify` with `txHash: ""` (empty string) returns the same error.
- [ ] The audit log entry for a missing `txHash` includes a meaningful `targetId` (e.g. the request IP or a request ID).
- [ ] A unit test covers all three missing/null/empty cases.

---

## Issue #24: `schoolContext.js` middleware does not handle the case where the school is deactivated mid-request

**Labels:** `bug`, `backend`

### Problem

`backend/src/middleware/schoolContext.js` resolves the school from the request header and attaches it to `req.school`. However, it only checks `isActive: true` at the time the middleware runs. If a school is deactivated between the middleware check and the controller execution (e.g. in a concurrent request), the controller will operate on a deactivated school's data.

While this is a rare race condition, it is more likely in automated test environments or during school deactivation workflows. More importantly, the middleware does not set a `Cache-Control: no-store` header on responses for deactivated schools, meaning a CDN or reverse proxy could cache a `404` response and serve it to future requests even after the school is reactivated.

### Proposed Fix

Add a check in the middleware that returns `403 SCHOOL_INACTIVE` (not `404`) when the school exists but is inactive, so callers can distinguish between "school not found" and "school temporarily deactivated". Add `Cache-Control: no-store` to error responses.

### Acceptance Criteria

- [ ] Requests to a deactivated school return `403` with `code: SCHOOL_INACTIVE`.
- [ ] Requests to a non-existent school return `404` with `code: NOT_FOUND`.
- [ ] Error responses from `schoolContext.js` include `Cache-Control: no-store`.
- [ ] A test covers the deactivated school scenario.
- [ ] Existing school context tests continue to pass.

---

## Issue #25: `feeAdjustmentEngine.js` does not validate that adjustment rules do not create negative fee amounts

**Labels:** `bug`, `backend`

### Problem

`backend/src/services/feeAdjustmentEngine.js` applies fee adjustment rules (discounts, scholarships, surcharges) to student fee amounts. The engine applies percentage and fixed-amount adjustments but does not validate that the resulting fee amount is non-negative. A combination of multiple discount rules could reduce a fee below zero, resulting in a negative `feeAmount` stored in the `Student` document.

The `studentModel.js` has `min: [0, 'Fee amount cannot be negative']` on the `feeAmount` field, which would catch this at the Mongoose validation level — but only if `save()` is called with `runValidators: true`. If the adjustment engine uses `updateMany` or `findOneAndUpdate` without `runValidators: true`, the validation is bypassed.

### Proposed Fix

Add a post-adjustment validation step in `feeAdjustmentEngine.js` that clamps the result to a minimum of 0 (or a configurable minimum fee). Log a warning when clamping occurs.

### Acceptance Criteria

- [ ] `feeAdjustmentEngine` never produces a negative fee amount.
- [ ] When multiple discount rules would reduce the fee below zero, the fee is clamped to 0 (or `MIN_FEE_AMOUNT` if configured).
- [ ] A warning is logged when clamping occurs, including the student ID and the unclamped amount.
- [ ] Unit tests in `tests/feeAdjustmentRules.test.js` cover the negative-fee scenario.
- [ ] Existing fee adjustment tests continue to pass.

---

## Issue #11: In-memory transaction queue is lost on server restart — submitted transactions stuck in SUBMITTED status

**Labels:** `bug`, `reliability`, `backend`

### Problem

`backend/src/queue/transactionQueue.js` implements an in-memory queue for processing submitted Stellar transactions. When the server restarts (deployment, crash, OOM kill), all jobs in the queue are lost. Any transaction that was submitted to the Stellar network but not yet verified will never be verified, and the associated payment record will remain in `SUBMITTED` status indefinitely.

The `transactionRetryQueue.js` uses BullMQ (Redis-backed) for the retry queue, which is durable. But the primary transaction queue is in-memory only. There is no background job that scans for payments stuck in `SUBMITTED` status and re-queues them for verification. A payment can be stuck in `SUBMITTED` forever if the server restarts between submission and verification.

### Proposed Fix

Back the transaction queue with Redis using BullMQ (already a dependency). Add a startup reconciliation job that finds all payments in `SUBMITTED` status older than 5 minutes and re-queues them. Add `GET /api/payments/stuck` (admin-only) to list stuck payments.

### Acceptance Criteria

- [ ] The transaction queue is backed by Redis (BullMQ) when `REDIS_HOST` is configured; falls back to in-memory with a startup warning.
- [ ] On server startup, payments in `SUBMITTED` status older than `STUCK_PAYMENT_THRESHOLD_MS` are automatically re-queued.
- [ ] `GET /api/payments/stuck` (admin-only) returns payments in `SUBMITTED` status older than the threshold.
- [ ] The startup reconciliation job is logged at `info` level with the count of re-queued payments.
- [ ] Existing `tests/transactionQueueDurability.test.js` tests are updated to cover the new behavior.

---

## Issue #12: Soft-deleted payments appear in `GET /api/payments` responses

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

`getAllPayments` in `paymentController.js` filters out payments where `studentDeleted: true` but does not filter out payments where `deletedAt` is set. The `Payment` model has a `deletedAt` field and the `softDelete` utility is applied to the schema, but the explicit filter object passed to `Payment.find(filter)` does not include `deletedAt: null`.

The `softDelete` utility adds a query middleware hook that appends `{ deletedAt: null }` to `find` queries, but this may not apply correctly when an explicit filter object is provided depending on Mongoose version. `getStudentPayments` and `getStudentBalance` also do not explicitly filter `deletedAt: null`, relying entirely on the middleware hook.

### Proposed Fix

Explicitly add `deletedAt: null` to all payment query filters in `getAllPayments`, `getStudentPayments`, `getStudentBalance`, `getOverpayments`, `getSuspiciousPayments`, `getPendingPayments`, and all report aggregations.

### Acceptance Criteria

- [ ] `GET /api/payments` does not return payments where `deletedAt` is set.
- [ ] `GET /api/payments/:studentId` does not return soft-deleted payments.
- [ ] `GET /api/payments/:studentId/balance` excludes soft-deleted payments from the total paid calculation.
- [ ] Report aggregations in `reportService.js` exclude soft-deleted payments.
- [ ] A test creates a payment, soft-deletes it, and asserts it does not appear in any of the above endpoints.

---

## Issue #13: No rate limiting on `POST /api/students/bulk` — enables denial-of-service via large CSV uploads

**Labels:** `security`, `backend`, `rate-limiting`

### Problem

`POST /api/students/bulk` accepts CSV files up to 5 MB with up to 10,000 rows. The endpoint is subject only to the general rate limiter (100 requests per 15 minutes). An attacker can upload 100 × 10,000-row CSVs in 15 minutes, triggering up to 1,000,000 sequential MongoDB queries. The CSV parsing itself is CPU-intensive for large files; 100 concurrent large uploads can exhaust Node.js's single-threaded event loop.

Additionally, there is no authentication on this endpoint (see Issue #5), so the attack requires no credentials. The file size validation runs before parsing, but there is no per-IP rate limit specific to this expensive endpoint.

### Proposed Fix

Add a dedicated rate limiter for bulk import (maximum 5 requests per hour per IP). Require admin authentication. Process files with more than 500 rows asynchronously (return `202 Accepted` with a job ID).

### Acceptance Criteria

- [ ] `POST /api/students/bulk` is protected by a dedicated rate limiter: maximum 5 requests per hour per IP.
- [ ] Requests exceeding the rate limit return `429` with `code: RATE_LIMIT_EXCEEDED`.
- [ ] The endpoint requires admin authentication.
- [ ] File size is validated before the CSV stream is opened.
- [ ] A test asserts that the 6th bulk import request within an hour returns `429`.

---

## Issue #14: Fee cascade update sets `remainingBalance: null` instead of recalculating per student

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

When `PUT /api/fees/:className` is called with `cascadeToStudents: true`, the controller runs `Student.updateMany(..., { feeAmount, remainingBalance: null })`. Setting `remainingBalance: null` is incorrect — it should be recalculated as `feeAmount - totalPaid` for each student. Setting it to `null` means `GET /api/students/:studentId` returns `remainingBalance: null` until the student's next payment.

The `feePaid` flag is also not updated by the cascade. A student who had fully paid the old fee amount may now be marked as unpaid after a fee increase, or vice versa. The `isOverdue` virtual depends on `feePaid`, so overdue calculations will also be wrong.

### Proposed Fix

Replace `updateMany` with per-student updates that recalculate `remainingBalance` and `feePaid`. Process in batches of 500 to avoid memory issues for large classes.

### Acceptance Criteria

- [ ] After cascade update, all students in the class have correct `feeAmount`, `remainingBalance`, and `feePaid` values.
- [ ] A student who had `totalPaid >= oldFeeAmount` and `newFeeAmount > oldFeeAmount` has `feePaid: false` after the cascade.
- [ ] `remainingBalance` is never `null` after a cascade update.
- [ ] The cascade is performed in batches of 500 students.
- [ ] Unit tests cover fee increase, fee decrease, and no-change scenarios.

---

## Issue #15: Health check endpoint does not verify Stellar Horizon connectivity

**Labels:** `enhancement`, `observability`, `backend`

### Problem

`GET /health` does not verify Stellar Horizon connectivity. If the Horizon API is unreachable, the health endpoint still returns `200 ok` even though `POST /api/payments/verify` will fail for all new transactions, `POST /api/payments/sync` will fail, and background polling will silently stop matching payments. Load balancers and uptime monitors will not detect a Stellar outage, and the system will appear healthy while payments are not being processed.

The README documents that `GET /health` should return `200 { status: "degraded" }` when a subsystem is unreachable, but the Stellar subsystem is not checked.

### Proposed Fix

Add a Stellar Horizon connectivity check with a 3-second timeout and no retries. If Stellar is unreachable, return `200 { status: "degraded", details: { stellar: { status: "unreachable" } } }`.

### Acceptance Criteria

- [ ] `GET /health` includes a `stellar` subsystem in the response.
- [ ] When Stellar Horizon is unreachable, `GET /health` returns `200` with `status: "degraded"`.
- [ ] The Stellar health check has a maximum timeout of 3 seconds and does not retry.
- [ ] `GET /health` response time is under 5 seconds even when Stellar is unreachable.
- [ ] Unit tests in `tests/health.test.js` cover all healthy, Stellar unreachable, and MongoDB disconnected scenarios.

---

## Issue #16: Audit log endpoint has no pagination — causes memory exhaustion for large audit logs

**Labels:** `performance`, `backend`, `observability`

### Problem

`GET /api/audit-logs` in `auditController.js` fetches audit log entries without pagination, returning all matching records in a single response. A busy school with many payment verifications can accumulate thousands of audit log entries per day. Fetching all of them in one request loads the entire result set into Node.js memory before serializing to JSON.

The frontend `audit-logs.jsx` page loads all audit logs at once, which can cause the browser to freeze for large datasets. The `.kiro/specs/audit-log-pagination/` spec directory exists, indicating this was planned but not implemented.

### Proposed Fix

Implement offset-based pagination consistent with `getAllPayments` and `getStudentPayments`. Support filtering by `action`, `startDate`, `endDate`, `result`, and `performedBy`.

### Acceptance Criteria

- [ ] `GET /api/audit-logs` supports `page` (default 1) and `limit` (default 50, max 200) query parameters.
- [ ] The response includes a `pagination` object with `page`, `limit`, `total`, and `totalPages`.
- [ ] The endpoint never loads more than `limit` documents into memory at once.
- [ ] The frontend `audit-logs.jsx` page is updated to use paginated loading.
- [ ] The `.kiro/specs/audit-log-pagination/tasks.md` tasks are completed.

---

## Issue #17: `paymentModel` pre-save hook blocks `SUCCESS → DISPUTED` transition needed by admin override

**Labels:** `bug`, `backend`

### Problem

The `paymentModel` pre-save hook enforces immutability for payments in `SUCCESS` or `FAILED` status. However, `updatePaymentStatus` in `paymentController.js` allows the transition `SUCCESS → DISPUTED`. The controller uses `findOneAndUpdate` (not `save`), which bypasses Mongoose pre-save hooks — so the transition currently works, but only because it bypasses the hook. Any future refactor that switches to `save()` will silently break admin dispute flagging.

The two mechanisms (pre-save hook and `ALLOWED_TRANSITIONS`) are inconsistent and their interaction is not documented. The `FAILED → SUCCESS` transition is blocked by both, but for different reasons.

### Proposed Fix

Remove the blanket immutability check from the pre-save hook. Enforce immutability at the controller/service layer where business rules are defined. Add an explicit exception for `SUCCESS → DISPUTED` or document the bypass.

### Acceptance Criteria

- [ ] `PATCH /api/payments/:txHash/status` with `{ status: "DISPUTED" }` on a `SUCCESS` payment succeeds.
- [ ] `PATCH /api/payments/:txHash/status` with an invalid transition returns `400 INVALID_TRANSITION`.
- [ ] The pre-save hook and `ALLOWED_TRANSITIONS` enforce the same rules.
- [ ] A unit test covers the `SUCCESS → DISPUTED` transition via both `findOneAndUpdate` and `save()`.
- [ ] Existing `tests/updatePaymentStatus.test.js` tests continue to pass.

---

## Issue #18: `generateStudentId` has no retry loop — ID collisions surface as unexpected 409 errors

**Labels:** `bug`, `backend`

### Problem

`backend/src/utils/generateStudentId.js` generates a student ID when `studentId` is not provided in the registration request. The function generates a random ID but does not check for uniqueness or retry on collision. If the generated ID collides with an existing one, `registerStudent` throws a `11000` duplicate key error, which is caught and returned as `409 DUPLICATE_STUDENT` — but the caller asked for an auto-generated ID, so they have no way to resolve this without retrying the entire registration.

The collision probability increases as the number of students grows. With a short ID format, collisions become likely at a few thousand students.

### Proposed Fix

Add a retry loop in `generateStudentId` that checks for existence and regenerates if a collision is detected (up to 5 attempts). Use a higher-entropy ID format. Ensure the generated ID is ≤ 28 characters (Stellar memo limit).

### Acceptance Criteria

- [ ] `generateStudentId` retries up to 5 times if the generated ID already exists in the school.
- [ ] After 5 failed attempts, it throws `STUDENT_ID_GENERATION_FAILED`.
- [ ] The generated ID is ≤ 28 characters.
- [ ] Unit tests cover successful generation, single collision with retry, and exhausted retries.
- [ ] Existing `tests/generateStudentId.test.js` tests continue to pass.

---

## Issue #19: Frontend dashboard fetches all students without pagination — freezes for large schools

**Labels:** `performance`, `frontend`

### Problem

`frontend/src/pages/dashboard.jsx` fetches the student list from `GET /api/students`. The backend supports pagination but the frontend does not use it — it fetches all students in a single request. For schools with hundreds of students, the dashboard either shows only the first 50 students with no indication that more exist (silent data truncation), or loads all students into memory causing browser jank.

The dashboard's payment summary table computes the summary client-side from all students and payments, which is an O(n) memory operation that degrades as the school grows.

### Proposed Fix

Paginate the student list (20 per page). Add search and filter controls using the backend's existing `?search=`, `?class=`, `?status=` filters. Use the server-side `getPaymentSummary` endpoint instead of computing client-side.

### Acceptance Criteria

- [ ] The dashboard student list is paginated: 20 students per page with page navigation controls.
- [ ] The dashboard shows the total student count and current page range.
- [ ] Search by name or student ID is supported.
- [ ] Filter by payment status and class is supported.
- [ ] Page navigation is accessible (keyboard-navigable, ARIA labels).

---

## Issue #20: No end-to-end test covers the full payment flow from intent creation to blockchain sync

**Labels:** `testing`, `quality`

### Problem

The test suite has separate unit tests for individual components but no single test that exercises the complete payment flow: create school and student → create payment intent → submit transaction → verify transaction hash → confirm payment recorded → sync from blockchain → assert student `feePaid` updated. Without a full end-to-end test, regressions in the payment flow (like the double-sync bug or memo encryption bug) can be introduced without any test failing.

`tests/e2e-payment-flow.test.js` exists but may not cover all steps, particularly the sync flow and the interaction between `PaymentIntent`, `Payment`, and `Student` models.

### Proposed Fix

Write a comprehensive end-to-end test using in-memory MongoDB and mocked Stellar SDK covering all 7 steps and edge cases: overpayment, underpayment, duplicate transaction, expired payment intent, missing memo.

### Acceptance Criteria

- [ ] The test covers exact payment, overpayment, underpayment, duplicate tx, missing memo, expired intent, and sync flow.
- [ ] All tests use mocked Stellar SDK — no real network calls.
- [ ] Tests run in under 30 seconds total.
- [ ] The test file is included in the CI workflow.
- [ ] All existing tests continue to pass.

---

## Issue #21: Missing compound index on `payments` collection for `schoolId + status + confirmedAt` causes slow report queries

**Labels:** `performance`, `backend`, `database`

### Problem

`reportService.js` runs several aggregation pipelines that filter by `{ schoolId, status: 'SUCCESS', studentDeleted: { $ne: true } }` and sort by `confirmedAt`. The `paymentModel.js` defines individual indexes on `schoolId`, `status`, and `confirmedAt` separately, but MongoDB can only use one index per query stage. Without a compound index covering all three fields, MongoDB must perform a collection scan or use a partial index and then filter in memory.

For a school with 50,000 payment records, the `generateReport` and `getDashboardMetrics` functions can take several seconds. The `aggregateByDate` pipeline groups by date and sorts — without the right index, MongoDB cannot use an index scan for the sort stage and must sort the entire filtered result set in memory.

The existing indexes in `paymentModel.js` include `{ schoolId: 1, confirmedAt: -1 }` and `{ schoolId: 1, status: 1, confirmedAt: -1 }`, but the report queries also filter `studentDeleted: { $ne: true }` which is not covered by any compound index.

### Proposed Fix

Add a partial index that covers the most common report query pattern:

```js
paymentSchema.index(
  { schoolId: 1, status: 1, confirmedAt: -1 },
  { partialFilterExpression: { studentDeleted: { $ne: true }, deletedAt: null } }
);
```

Add a migration script to create this index on existing collections.

### Acceptance Criteria

- [ ] A compound index `{ schoolId: 1, status: 1, confirmedAt: -1 }` with a partial filter expression for `studentDeleted` and `deletedAt` is added to `paymentModel.js`.
- [ ] A migration script `backend/migrations/013_add_payment_report_index.js` creates the index on existing collections.
- [ ] `EXPLAIN` output for `generateReport` shows the new index being used (verified in a test or documented).
- [ ] Report generation time for 10,000 payments is under 500 ms (measured in a benchmark test).
- [ ] Existing tests continue to pass.

---

## Issue #22: `reportService.reportToCsv` does not escape commas or quotes in field values — produces malformed CSV

**Labels:** `bug`, `backend`

### Problem

`reportService.js` implements `reportToCsv` by joining field values with commas:

```js
lines.push([row.date, row.totalAmount, row.paymentCount, ...].join(','));
```

If any field value contains a comma (e.g. a class name like `"Grade 5, Advanced"`) or a double-quote, the resulting CSV will be malformed. Most CSV parsers will misinterpret the row, splitting it at the embedded comma and producing incorrect column alignment.

The summary section also concatenates values directly: `lines.push(`Generated At,${report.generatedAt}`)`. If `generatedAt` contained a comma (it doesn't currently, but the pattern is fragile), it would break. School names and class names are user-supplied strings that can contain any characters.

### Proposed Fix

Implement proper CSV escaping: wrap each field in double quotes and escape internal double quotes by doubling them.

```js
function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
```

### Acceptance Criteria

- [ ] `reportToCsv` wraps field values containing commas, quotes, or newlines in double quotes.
- [ ] Internal double quotes are escaped by doubling (`"` → `""`).
- [ ] A test asserts that a class name containing a comma produces a valid CSV row.
- [ ] A test asserts that a school name containing a double quote produces a valid CSV row.
- [ ] The CSV output can be parsed by standard CSV parsers (Node.js `csv-parser`, Excel, Google Sheets).

---

## Issue #23: `POST /api/payments/verify` does not validate that `txHash` is present in the request body before processing

**Labels:** `bug`, `backend`

### Problem

`verifyPayment` in `paymentController.js` calls `validateTransactionHash(txHash)` where `txHash` comes from `req.body.txHash`. If the request body is empty or `txHash` is missing, `txHash` is `undefined`. `validateTransactionHash(undefined)` may return `{ valid: false }` with a generic error, but the error message will be confusing ("undefined is not a valid transaction hash") rather than the clear "txHash is required" message that would help the caller.

Additionally, the audit log entry for a failed validation attempt uses `req.body?.txHash || 'unknown'` as the `targetId`, which means failed attempts with missing `txHash` are logged with `targetId: 'unknown'` — making it impossible to correlate audit log entries with specific requests.

### Proposed Fix

Add an explicit presence check before calling `validateTransactionHash`:

```js
if (!req.body.txHash) {
  return res.status(400).json({ error: 'txHash is required', code: 'VALIDATION_ERROR' });
}
```

### Acceptance Criteria

- [ ] `POST /api/payments/verify` with a missing `txHash` returns `400` with `code: VALIDATION_ERROR` and message `txHash is required`.
- [ ] `POST /api/payments/verify` with `txHash: null` returns the same error.
- [ ] `POST /api/payments/verify` with `txHash: ""` (empty string) returns the same error.
- [ ] The audit log entry for a missing `txHash` includes a meaningful `targetId` (e.g. the request IP or a request ID).
- [ ] A unit test covers all three missing/null/empty cases.

---

## Issue #24: `schoolContext.js` middleware does not handle the case where the school is deactivated mid-request

**Labels:** `bug`, `backend`

### Problem

`backend/src/middleware/schoolContext.js` resolves the school from the request header and attaches it to `req.school`. However, it only checks `isActive: true` at the time the middleware runs. If a school is deactivated between the middleware check and the controller execution (e.g. in a concurrent request), the controller will operate on a deactivated school's data.

While this is a rare race condition, it is more likely in automated test environments or during school deactivation workflows. More importantly, the middleware does not set a `Cache-Control: no-store` header on responses for deactivated schools, meaning a CDN or reverse proxy could cache a `404` response and serve it to future requests even after the school is reactivated.

### Proposed Fix

Add a check in the middleware that returns `403 SCHOOL_INACTIVE` (not `404`) when the school exists but is inactive, so callers can distinguish between "school not found" and "school temporarily deactivated". Add `Cache-Control: no-store` to error responses.

### Acceptance Criteria

- [ ] Requests to a deactivated school return `403` with `code: SCHOOL_INACTIVE`.
- [ ] Requests to a non-existent school return `404` with `code: NOT_FOUND`.
- [ ] Error responses from `schoolContext.js` include `Cache-Control: no-store`.
- [ ] A test covers the deactivated school scenario.
- [ ] Existing school context tests continue to pass.

---

## Issue #25: `feeAdjustmentEngine.js` does not validate that adjustment rules do not create negative fee amounts

**Labels:** `bug`, `backend`

### Problem

`backend/src/services/feeAdjustmentEngine.js` applies fee adjustment rules (discounts, scholarships, surcharges) to student fee amounts. The engine applies percentage and fixed-amount adjustments but does not validate that the resulting fee amount is non-negative. A combination of multiple discount rules could reduce a fee below zero, resulting in a negative `feeAmount` stored in the `Student` document.

The `studentModel.js` has `min: [0, 'Fee amount cannot be negative']` on the `feeAmount` field, which would catch this at the Mongoose validation level — but only if `save()` is called with `runValidators: true`. If the adjustment engine uses `updateMany` or `findOneAndUpdate` without `runValidators: true`, the validation is bypassed.

### Proposed Fix

Add a post-adjustment validation step in `feeAdjustmentEngine.js` that clamps the result to a minimum of 0 (or a configurable minimum fee). Log a warning when clamping occurs.

### Acceptance Criteria

- [ ] `feeAdjustmentEngine` never produces a negative fee amount.
- [ ] When multiple discount rules would reduce the fee below zero, the fee is clamped to 0 (or `MIN_FEE_AMOUNT` if configured).
- [ ] A warning is logged when clamping occurs, including the student ID and the unclamped amount.
- [ ] Unit tests in `tests/feeAdjustmentRules.test.js` cover the negative-fee scenario.
- [ ] Existing fee adjustment tests continue to pass.

---

## Issue #11: In-memory transaction queue is lost on server restart — submitted transactions stuck in SUBMITTED status

**Labels:** `bug`, `reliability`, `backend`

### Problem

`backend/src/queue/transactionQueue.js` implements an in-memory queue for processing submitted Stellar transactions. When the server restarts (deployment, crash, OOM kill), all jobs in the queue are lost. Any transaction that was submitted to the Stellar network but not yet verified will never be verified, and the associated payment record will remain in `SUBMITTED` status indefinitely.

The `transactionRetryQueue.js` uses BullMQ (Redis-backed) for the retry queue, which is durable. But the primary transaction queue is in-memory only. There is no background job that scans for payments stuck in `SUBMITTED` status and re-queues them for verification. A payment can be stuck in `SUBMITTED` forever if the server restarts between submission and verification.

### Proposed Fix

Back the transaction queue with Redis using BullMQ (already a dependency). Add a startup reconciliation job that finds all payments in `SUBMITTED` status older than 5 minutes and re-queues them. Add `GET /api/payments/stuck` (admin-only) to list stuck payments.

### Acceptance Criteria

- [ ] The transaction queue is backed by Redis (BullMQ) when `REDIS_HOST` is configured; falls back to in-memory with a startup warning.
- [ ] On server startup, payments in `SUBMITTED` status older than `STUCK_PAYMENT_THRESHOLD_MS` are automatically re-queued.
- [ ] `GET /api/payments/stuck` (admin-only) returns payments in `SUBMITTED` status older than the threshold.
- [ ] The startup reconciliation job is logged at `info` level with the count of re-queued payments.
- [ ] Existing `tests/transactionQueueDurability.test.js` tests are updated to cover the new behavior.

---

## Issue #12: Soft-deleted payments appear in `GET /api/payments` responses

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

`getAllPayments` in `paymentController.js` filters out payments where `studentDeleted: true` but does not filter out payments where `deletedAt` is set. The `Payment` model has a `deletedAt` field and the `softDelete` utility is applied to the schema, but the explicit filter object passed to `Payment.find(filter)` does not include `deletedAt: null`.

The `softDelete` utility adds a query middleware hook that appends `{ deletedAt: null }` to `find` queries, but this may not apply correctly when an explicit filter object is provided depending on Mongoose version. `getStudentPayments` and `getStudentBalance` also do not explicitly filter `deletedAt: null`, relying entirely on the middleware hook.

### Proposed Fix

Explicitly add `deletedAt: null` to all payment query filters in `getAllPayments`, `getStudentPayments`, `getStudentBalance`, `getOverpayments`, `getSuspiciousPayments`, `getPendingPayments`, and all report aggregations.

### Acceptance Criteria

- [ ] `GET /api/payments` does not return payments where `deletedAt` is set.
- [ ] `GET /api/payments/:studentId` does not return soft-deleted payments.
- [ ] `GET /api/payments/:studentId/balance` excludes soft-deleted payments from the total paid calculation.
- [ ] Report aggregations in `reportService.js` exclude soft-deleted payments.
- [ ] A test creates a payment, soft-deletes it, and asserts it does not appear in any of the above endpoints.

---

## Issue #13: No rate limiting on `POST /api/students/bulk` — enables denial-of-service via large CSV uploads

**Labels:** `security`, `backend`, `rate-limiting`

### Problem

`POST /api/students/bulk` accepts CSV files up to 5 MB with up to 10,000 rows. The endpoint is subject only to the general rate limiter (100 requests per 15 minutes). An attacker can upload 100 × 10,000-row CSVs in 15 minutes, triggering up to 1,000,000 sequential MongoDB queries. The CSV parsing itself is CPU-intensive for large files; 100 concurrent large uploads can exhaust Node.js's single-threaded event loop.

Additionally, there is no authentication on this endpoint (see Issue #5), so the attack requires no credentials. The file size validation runs before parsing, but there is no per-IP rate limit specific to this expensive endpoint.

### Proposed Fix

Add a dedicated rate limiter for bulk import (maximum 5 requests per hour per IP). Require admin authentication. Process files with more than 500 rows asynchronously (return `202 Accepted` with a job ID).

### Acceptance Criteria

- [ ] `POST /api/students/bulk` is protected by a dedicated rate limiter: maximum 5 requests per hour per IP.
- [ ] Requests exceeding the rate limit return `429` with `code: RATE_LIMIT_EXCEEDED`.
- [ ] The endpoint requires admin authentication.
- [ ] File size is validated before the CSV stream is opened.
- [ ] A test asserts that the 6th bulk import request within an hour returns `429`.

---

## Issue #14: Fee cascade update sets `remainingBalance: null` instead of recalculating per student

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

When `PUT /api/fees/:className` is called with `cascadeToStudents: true`, the controller runs `Student.updateMany(..., { feeAmount, remainingBalance: null })`. Setting `remainingBalance: null` is incorrect — it should be recalculated as `feeAmount - totalPaid` for each student. Setting it to `null` means `GET /api/students/:studentId` returns `remainingBalance: null` until the student's next payment.

The `feePaid` flag is also not updated by the cascade. A student who had fully paid the old fee amount may now be marked as unpaid after a fee increase, or vice versa. The `isOverdue` virtual depends on `feePaid`, so overdue calculations will also be wrong.

### Proposed Fix

Replace `updateMany` with per-student updates that recalculate `remainingBalance` and `feePaid`. Process in batches of 500 to avoid memory issues for large classes.

### Acceptance Criteria

- [ ] After cascade update, all students in the class have correct `feeAmount`, `remainingBalance`, and `feePaid` values.
- [ ] A student who had `totalPaid >= oldFeeAmount` and `newFeeAmount > oldFeeAmount` has `feePaid: false` after the cascade.
- [ ] `remainingBalance` is never `null` after a cascade update.
- [ ] The cascade is performed in batches of 500 students.
- [ ] Unit tests cover fee increase, fee decrease, and no-change scenarios.

---

## Issue #15: Health check endpoint does not verify Stellar Horizon connectivity

**Labels:** `enhancement`, `observability`, `backend`

### Problem

`GET /health` does not verify Stellar Horizon connectivity. If the Horizon API is unreachable, the health endpoint still returns `200 ok` even though `POST /api/payments/verify` will fail for all new transactions, `POST /api/payments/sync` will fail, and background polling will silently stop matching payments. Load balancers and uptime monitors will not detect a Stellar outage, and the system will appear healthy while payments are not being processed.

The README documents that `GET /health` should return `200 { status: "degraded" }` when a subsystem is unreachable, but the Stellar subsystem is not checked.

### Proposed Fix

Add a Stellar Horizon connectivity check with a 3-second timeout and no retries. If Stellar is unreachable, return `200 { status: "degraded", details: { stellar: { status: "unreachable" } } }`.

### Acceptance Criteria

- [ ] `GET /health` includes a `stellar` subsystem in the response.
- [ ] When Stellar Horizon is unreachable, `GET /health` returns `200` with `status: "degraded"`.
- [ ] The Stellar health check has a maximum timeout of 3 seconds and does not retry.
- [ ] `GET /health` response time is under 5 seconds even when Stellar is unreachable.
- [ ] Unit tests in `tests/health.test.js` cover all healthy, Stellar unreachable, and MongoDB disconnected scenarios.

---

## Issue #16: Audit log endpoint has no pagination — causes memory exhaustion for large audit logs

**Labels:** `performance`, `backend`, `observability`

### Problem

`GET /api/audit-logs` in `auditController.js` fetches audit log entries without pagination, returning all matching records in a single response. A busy school with many payment verifications can accumulate thousands of audit log entries per day. Fetching all of them in one request loads the entire result set into Node.js memory before serializing to JSON.

The frontend `audit-logs.jsx` page loads all audit logs at once, which can cause the browser to freeze for large datasets. The `.kiro/specs/audit-log-pagination/` spec directory exists, indicating this was planned but not implemented.

### Proposed Fix

Implement offset-based pagination consistent with `getAllPayments` and `getStudentPayments`. Support filtering by `action`, `startDate`, `endDate`, `result`, and `performedBy`.

### Acceptance Criteria

- [ ] `GET /api/audit-logs` supports `page` (default 1) and `limit` (default 50, max 200) query parameters.
- [ ] The response includes a `pagination` object with `page`, `limit`, `total`, and `totalPages`.
- [ ] The endpoint never loads more than `limit` documents into memory at once.
- [ ] The frontend `audit-logs.jsx` page is updated to use paginated loading.
- [ ] The `.kiro/specs/audit-log-pagination/tasks.md` tasks are completed.

---

## Issue #17: `paymentModel` pre-save hook blocks `SUCCESS → DISPUTED` transition needed by admin override

**Labels:** `bug`, `backend`

### Problem

The `paymentModel` pre-save hook enforces immutability for payments in `SUCCESS` or `FAILED` status. However, `updatePaymentStatus` in `paymentController.js` allows the transition `SUCCESS → DISPUTED`. The controller uses `findOneAndUpdate` (not `save`), which bypasses Mongoose pre-save hooks — so the transition currently works, but only because it bypasses the hook. Any future refactor that switches to `save()` will silently break admin dispute flagging.

The two mechanisms (pre-save hook and `ALLOWED_TRANSITIONS`) are inconsistent and their interaction is not documented. The `FAILED → SUCCESS` transition is blocked by both, but for different reasons.

### Proposed Fix

Remove the blanket immutability check from the pre-save hook. Enforce immutability at the controller/service layer where business rules are defined. Add an explicit exception for `SUCCESS → DISPUTED` or document the bypass.

### Acceptance Criteria

- [ ] `PATCH /api/payments/:txHash/status` with `{ status: "DISPUTED" }` on a `SUCCESS` payment succeeds.
- [ ] `PATCH /api/payments/:txHash/status` with an invalid transition returns `400 INVALID_TRANSITION`.
- [ ] The pre-save hook and `ALLOWED_TRANSITIONS` enforce the same rules.
- [ ] A unit test covers the `SUCCESS → DISPUTED` transition via both `findOneAndUpdate` and `save()`.
- [ ] Existing `tests/updatePaymentStatus.test.js` tests continue to pass.

---

## Issue #18: `generateStudentId` has no retry loop — ID collisions surface as unexpected 409 errors

**Labels:** `bug`, `backend`

### Problem

`backend/src/utils/generateStudentId.js` generates a student ID when `studentId` is not provided in the registration request. The function generates a random ID but does not check for uniqueness or retry on collision. If the generated ID collides with an existing one, `registerStudent` throws a `11000` duplicate key error, which is caught and returned as `409 DUPLICATE_STUDENT` — but the caller asked for an auto-generated ID, so they have no way to resolve this without retrying the entire registration.

The collision probability increases as the number of students grows. With a short ID format, collisions become likely at a few thousand students.

### Proposed Fix

Add a retry loop in `generateStudentId` that checks for existence and regenerates if a collision is detected (up to 5 attempts). Use a higher-entropy ID format. Ensure the generated ID is ≤ 28 characters (Stellar memo limit).

### Acceptance Criteria

- [ ] `generateStudentId` retries up to 5 times if the generated ID already exists in the school.
- [ ] After 5 failed attempts, it throws `STUDENT_ID_GENERATION_FAILED`.
- [ ] The generated ID is ≤ 28 characters.
- [ ] Unit tests cover successful generation, single collision with retry, and exhausted retries.
- [ ] Existing `tests/generateStudentId.test.js` tests continue to pass.

---

## Issue #19: Frontend dashboard fetches all students without pagination — freezes for large schools

**Labels:** `performance`, `frontend`

### Problem

`frontend/src/pages/dashboard.jsx` fetches the student list from `GET /api/students`. The backend supports pagination but the frontend does not use it — it fetches all students in a single request. For schools with hundreds of students, the dashboard either shows only the first 50 students with no indication that more exist (silent data truncation), or loads all students into memory causing browser jank.

The dashboard's payment summary table computes the summary client-side from all students and payments, which is an O(n) memory operation that degrades as the school grows.

### Proposed Fix

Paginate the student list (20 per page). Add search and filter controls using the backend's existing `?search=`, `?class=`, `?status=` filters. Use the server-side `getPaymentSummary` endpoint instead of computing client-side.

### Acceptance Criteria

- [ ] The dashboard student list is paginated: 20 students per page with page navigation controls.
- [ ] The dashboard shows the total student count and current page range.
- [ ] Search by name or student ID is supported.
- [ ] Filter by payment status and class is supported.
- [ ] Page navigation is accessible (keyboard-navigable, ARIA labels).

---

## Issue #20: No end-to-end test covers the full payment flow from intent creation to blockchain sync

**Labels:** `testing`, `quality`

### Problem

The test suite has separate unit tests for individual components but no single test that exercises the complete payment flow: create school and student → create payment intent → submit transaction → verify transaction hash → confirm payment recorded → sync from blockchain → assert student `feePaid` updated. Without a full end-to-end test, regressions in the payment flow (like the double-sync bug or memo encryption bug) can be introduced without any test failing.

`tests/e2e-payment-flow.test.js` exists but may not cover all steps, particularly the sync flow and the interaction between `PaymentIntent`, `Payment`, and `Student` models.

### Proposed Fix

Write a comprehensive end-to-end test using in-memory MongoDB and mocked Stellar SDK covering all 7 steps and edge cases: overpayment, underpayment, duplicate transaction, expired payment intent, missing memo.

### Acceptance Criteria

- [ ] The test covers exact payment, overpayment, underpayment, duplicate tx, missing memo, expired intent, and sync flow.
- [ ] All tests use mocked Stellar SDK — no real network calls.
- [ ] Tests run in under 30 seconds total.
- [ ] The test file is included in the CI workflow.
- [ ] All existing tests continue to pass.

---

## Issue #21: Missing compound index on `payments` collection for `schoolId + status + confirmedAt` causes slow report queries

**Labels:** `performance`, `backend`, `database`

### Problem

`reportService.js` runs several aggregation pipelines that filter by `{ schoolId, status: 'SUCCESS', studentDeleted: { $ne: true } }` and sort by `confirmedAt`. The `paymentModel.js` defines individual indexes on `schoolId`, `status`, and `confirmedAt` separately, but MongoDB can only use one index per query stage. Without a compound index covering all three fields, MongoDB must perform a collection scan or use a partial index and then filter in memory.

For a school with 50,000 payment records, the `generateReport` and `getDashboardMetrics` functions can take several seconds. The `aggregateByDate` pipeline groups by date and sorts — without the right index, MongoDB cannot use an index scan for the sort stage and must sort the entire filtered result set in memory.

The existing indexes in `paymentModel.js` include `{ schoolId: 1, confirmedAt: -1 }` and `{ schoolId: 1, status: 1, confirmedAt: -1 }`, but the report queries also filter `studentDeleted: { $ne: true }` which is not covered by any compound index.

### Proposed Fix

Add a partial index that covers the most common report query pattern:

```js
paymentSchema.index(
  { schoolId: 1, status: 1, confirmedAt: -1 },
  { partialFilterExpression: { studentDeleted: { $ne: true }, deletedAt: null } }
);
```

Add a migration script to create this index on existing collections.

### Acceptance Criteria

- [ ] A compound index `{ schoolId: 1, status: 1, confirmedAt: -1 }` with a partial filter expression for `studentDeleted` and `deletedAt` is added to `paymentModel.js`.
- [ ] A migration script `backend/migrations/013_add_payment_report_index.js` creates the index on existing collections.
- [ ] `EXPLAIN` output for `generateReport` shows the new index being used (verified in a test or documented).
- [ ] Report generation time for 10,000 payments is under 500 ms (measured in a benchmark test).
- [ ] Existing tests continue to pass.

---

## Issue #22: `reportService.reportToCsv` does not escape commas or quotes in field values — produces malformed CSV

**Labels:** `bug`, `backend`

### Problem

`reportService.js` implements `reportToCsv` by joining field values with commas:

```js
lines.push([row.date, row.totalAmount, row.paymentCount, ...].join(','));
```

If any field value contains a comma (e.g. a class name like `"Grade 5, Advanced"`) or a double-quote, the resulting CSV will be malformed. Most CSV parsers will misinterpret the row, splitting it at the embedded comma and producing incorrect column alignment.

The summary section also concatenates values directly: `lines.push(`Generated At,${report.generatedAt}`)`. If `generatedAt` contained a comma (it doesn't currently, but the pattern is fragile), it would break. School names and class names are user-supplied strings that can contain any characters.

### Proposed Fix

Implement proper CSV escaping: wrap each field in double quotes and escape internal double quotes by doubling them.

```js
function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
```

### Acceptance Criteria

- [ ] `reportToCsv` wraps field values containing commas, quotes, or newlines in double quotes.
- [ ] Internal double quotes are escaped by doubling (`"` → `""`).
- [ ] A test asserts that a class name containing a comma produces a valid CSV row.
- [ ] A test asserts that a school name containing a double quote produces a valid CSV row.
- [ ] The CSV output can be parsed by standard CSV parsers (Node.js `csv-parser`, Excel, Google Sheets).

---

## Issue #23: `POST /api/payments/verify` does not validate that `txHash` is present in the request body before processing

**Labels:** `bug`, `backend`

### Problem

`verifyPayment` in `paymentController.js` calls `validateTransactionHash(txHash)` where `txHash` comes from `req.body.txHash`. If the request body is empty or `txHash` is missing, `txHash` is `undefined`. `validateTransactionHash(undefined)` may return `{ valid: false }` with a generic error, but the error message will be confusing ("undefined is not a valid transaction hash") rather than the clear "txHash is required" message that would help the caller.

Additionally, the audit log entry for a failed validation attempt uses `req.body?.txHash || 'unknown'` as the `targetId`, which means failed attempts with missing `txHash` are logged with `targetId: 'unknown'` — making it impossible to correlate audit log entries with specific requests.

### Proposed Fix

Add an explicit presence check before calling `validateTransactionHash`:

```js
if (!req.body.txHash) {
  return res.status(400).json({ error: 'txHash is required', code: 'VALIDATION_ERROR' });
}
```

### Acceptance Criteria

- [ ] `POST /api/payments/verify` with a missing `txHash` returns `400` with `code: VALIDATION_ERROR` and message `txHash is required`.
- [ ] `POST /api/payments/verify` with `txHash: null` returns the same error.
- [ ] `POST /api/payments/verify` with `txHash: ""` (empty string) returns the same error.
- [ ] The audit log entry for a missing `txHash` includes a meaningful `targetId` (e.g. the request IP or a request ID).
- [ ] A unit test covers all three missing/null/empty cases.

---

## Issue #24: `schoolContext.js` middleware does not handle the case where the school is deactivated mid-request

**Labels:** `bug`, `backend`

### Problem

`backend/src/middleware/schoolContext.js` resolves the school from the request header and attaches it to `req.school`. However, it only checks `isActive: true` at the time the middleware runs. If a school is deactivated between the middleware check and the controller execution (e.g. in a concurrent request), the controller will operate on a deactivated school's data.

While this is a rare race condition, it is more likely in automated test environments or during school deactivation workflows. More importantly, the middleware does not set a `Cache-Control: no-store` header on responses for deactivated schools, meaning a CDN or reverse proxy could cache a `404` response and serve it to future requests even after the school is reactivated.

### Proposed Fix

Add a check in the middleware that returns `403 SCHOOL_INACTIVE` (not `404`) when the school exists but is inactive, so callers can distinguish between "school not found" and "school temporarily deactivated". Add `Cache-Control: no-store` to error responses.

### Acceptance Criteria

- [ ] Requests to a deactivated school return `403` with `code: SCHOOL_INACTIVE`.
- [ ] Requests to a non-existent school return `404` with `code: NOT_FOUND`.
- [ ] Error responses from `schoolContext.js` include `Cache-Control: no-store`.
- [ ] A test covers the deactivated school scenario.
- [ ] Existing school context tests continue to pass.

---

## Issue #25: `feeAdjustmentEngine.js` does not validate that adjustment rules do not create negative fee amounts

**Labels:** `bug`, `backend`

### Problem

`backend/src/services/feeAdjustmentEngine.js` applies fee adjustment rules (discounts, scholarships, surcharges) to student fee amounts. The engine applies percentage and fixed-amount adjustments but does not validate that the resulting fee amount is non-negative. A combination of multiple discount rules could reduce a fee below zero, resulting in a negative `feeAmount` stored in the `Student` document.

The `studentModel.js` has `min: [0, 'Fee amount cannot be negative']` on the `feeAmount` field, which would catch this at the Mongoose validation level — but only if `save()` is called with `runValidators: true`. If the adjustment engine uses `updateMany` or `findOneAndUpdate` without `runValidators: true`, the validation is bypassed.

### Proposed Fix

Add a post-adjustment validation step in `feeAdjustmentEngine.js` that clamps the result to a minimum of 0 (or a configurable minimum fee). Log a warning when clamping occurs.

### Acceptance Criteria

- [ ] `feeAdjustmentEngine` never produces a negative fee amount.
- [ ] When multiple discount rules would reduce the fee below zero, the fee is clamped to 0 (or `MIN_FEE_AMOUNT` if configured).
- [ ] A warning is logged when clamping occurs, including the student ID and the unclamped amount.
- [ ] Unit tests in `tests/feeAdjustmentRules.test.js` cover the negative-fee scenario.
- [ ] Existing fee adjustment tests continue to pass.

---
