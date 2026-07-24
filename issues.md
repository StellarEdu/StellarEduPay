# StellarEduPay — GitHub Issues

> Generated from a full codebase audit on 2026-05-26. Each issue is self-contained with context, problem statement, proposed solution, and acceptance criteria.

---

## Issue 1: `syncAllPayments` calls `syncPaymentsForSchool` twice and sends two responses

> **STATUS: RESOLVED (fixed before this audit was committed).** This audit was generated 2026-05-26, one day before the fix landed in `fix/559-560-561-562` (see `IMPLEMENTATION_SUMMARY.md`, 2026-05-27), but was committed to git on 2026-06-11, making it look newer than the fix. Current code (`backend/src/controllers/paymentAdminController.js`) calls `syncPaymentsForSchool` and `res.json` exactly once. Independently re-confirmed by `CHANGELOG.md` issue #731. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `bug`, `critical`, `backend`

### Problem

In `backend/src/controllers/paymentController.js`, the `syncAllPayments` handler contains a logic error that causes two serious problems simultaneously:

1. `syncPaymentsForSchool(req.school)` is called **twice** — once before `res.json(...)` and once after. The second call runs after the HTTP response has already been sent, meaning its result is silently discarded and any errors it throws are unhandled.
2. `res.json(...)` is called **twice** — the first call sends the response with the first sync's summary, and the second call (after the audit log) attempts to send another response on an already-closed socket. In Express this produces a `Cannot set headers after they are sent` error that pollutes logs and can crash the process in some configurations.

```js
// paymentController.js — syncAllPayments (current, broken)
const summary = await syncPaymentsForSchool(req.school);
res.json({ message: "Sync complete", summary: { ... } });   // ← first response sent here

const result = await syncPaymentsForSchool(req.school);     // ← second redundant call
// ...
res.json({ message: "Sync complete" });                     // ← second response — crashes
```

### Impact

- Every manual sync triggers two full blockchain polling cycles, doubling Horizon API usage and MongoDB writes.
- Duplicate payment records may be created if the idempotency check has a race window.
- The `Cannot set headers after they are sent` error appears in every sync log, masking real errors.
- The audit log captures the result of the second (redundant) sync, not the one whose summary was returned to the caller.

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
      await logAudit({ schoolId, action: 'payment_manual_sync', ... details: { syncResult: summary }, ... });
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
- [ ] The in-memory `_syncLocks` set is always cleaned up in the `finally` block (already present — must be preserved).
- [ ] Existing tests in `tests/payment.test.js` continue to pass.
- [ ] A new unit test asserts that `syncPaymentsForSchool` is called exactly once when `POST /api/payments/sync` is invoked.

---

## Issue 2: `GET /api/payments/:studentId` is not scoped to the requesting school

> **STATUS: RESOLVED (fixed before this audit was committed).** This audit was generated 2026-05-26, before the fix in `IMPLEMENTATION_SUMMARY.md` (2026-05-27, issue #561) landed. Current code (`backend/src/controllers/paymentQueryController.js`) includes `schoolId` in the student lookup, the payment find/count, and both the top-level and category-breakdown balance aggregations. `tests/cross-school-isolation.test.js` and `backend/tests/cross-school-isolation.test.js` exist and are substantial. Note: the separate, still-open issue is that `resolveSchool` trusts the `X-School-ID`/`X-School-Slug` header alone on read endpoints when no JWT is present — that's a different problem from this one. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `bug`, `security`, `multi-school`

### Problem

`getStudentPayments` in `paymentController.js` queries payments using both `schoolId` and `studentId`:

```js
const payments = await Payment.find({
  schoolId: req.schoolId,
  studentId: req.params.studentId,
});
```

However, `studentId` values are **not globally unique** — they are only unique within a school (enforced by the compound index `{ studentId: 1, schoolId: 1 }`). If two schools both have a student with ID `STU001`, a request from School A for `STU001` will correctly return only School A's payments because `schoolId` is included in the filter.

The actual data-leak vector is in the student existence check that runs **before** the payment query:

```js
const student = await Student.findOne({
  schoolId: req.schoolId,
  studentId: req.params.studentId,
});
if (!student) {
  return res.status(404).json({ error: "Student not found", code: "NOT_FOUND" });
}
```

This check is correct. **But** the `getStudentBalance` endpoint performs an aggregation that groups by `studentId` without a `schoolId` filter in the `$match` stage of the `categoryPayments` sub-aggregation:

```js
const categoryPayments = await Payment.aggregate([
  { $match: { schoolId, studentId, feeCategory: { $ne: null } } },
  ...
]);
```

While `schoolId` is present here, the top-level balance aggregation uses:

```js
const result = await Payment.aggregate([
  { $match: { schoolId, studentId } },
  ...
]);
```

The `studentId` here is a **string** from `req.params`, not a MongoDB ObjectId. If a malicious actor registers a student in their own school with the same `studentId` string as a student in a victim school, and then queries the balance endpoint, the aggregation will only return their own school's data because `schoolId` is in the match. However, the **payment history endpoint** (`GET /api/payments/:studentId`) does not validate that the student belongs to the school before returning payment records in all code paths — specifically when `req.schoolId` is derived from a header that can be spoofed if the `resolveSchool` middleware is bypassed or misconfigured.

The root issue is that there is no integration test covering cross-school payment isolation, making this class of bug invisible.

### Impact

- In a misconfigured or future deployment where `resolveSchool` middleware is not applied to a route, payment records from one school could be returned to a requester from another school.
- No cross-school data isolation tests exist, so regressions in this area will not be caught by CI.

### Proposed Fix

1. Add an explicit `schoolId` assertion in every payment query that accepts a `studentId` parameter.
2. Add integration tests that create two schools with overlapping `studentId` values and assert that each school only sees its own data.
3. Add a middleware-level guard that rejects requests where `req.schoolId` is absent or does not match a known school.

### Acceptance Criteria

- [ ] `GET /api/payments/:studentId` returns `404` when the student exists in a different school than the one identified by the request's school context.
- [ ] `GET /api/payments/:studentId/balance` returns `404` under the same condition.
- [ ] A test suite `tests/cross-school-isolation.test.js` is added with at least 5 test cases covering payment history, balance, and instructions endpoints across two schools with overlapping student IDs.
- [ ] All existing payment tests continue to pass.
- [ ] The `resolveSchool` middleware is applied to every payment and student route (verified by a route-level test that sends a request without a school header and expects `400`).

---

## Issue 3: `schoolModel.js` has no `timezone` field — all timestamps are stored and displayed in UTC without school context

**Labels:** `enhancement`, `multi-school`, `feature`

### Problem

The `School` model (`backend/src/models/schoolModel.js`) stores a `localCurrency` field for fiat conversion but has no `timezone` field. All timestamps in the system (`confirmedAt`, `createdAt`, `paymentDeadline`, etc.) are stored and returned in UTC.

This creates several user-facing problems:

1. **Reports are broken for non-UTC schools.** The `aggregateByDate` function in `reportService.js` groups payments by `$dateToString` using the default UTC timezone. A school in UTC+10 (e.g. Papua New Guinea) will see payments made at 11 PM local time grouped under the wrong date.
2. **Payment deadlines are ambiguous.** `paymentDeadline` is stored as a UTC `Date` but displayed without timezone context. A deadline of `2026-06-30T00:00:00Z` means June 29 at 2 PM in UTC-10, which is confusing for parents.
3. **Dashboard "today's payments"** in `reportService.getDashboardMetrics` uses `new Date()` (server UTC) as the start of today, which is wrong for schools in different timezones.
4. **Reminder scheduling** in `reminderService.js` runs on a fixed UTC interval with no awareness of school business hours.

### Proposed Solution

Add a `timezone` field to the `School` model (IANA timezone string, e.g. `"Pacific/Port_Moresby"`, `"America/New_York"`). Use this field in:

- `reportService.aggregateByDate` — pass `timezone` to MongoDB's `$dateToString` operator.
- `reportService.getDashboardMetrics` — compute "start of today" in the school's local timezone.
- All API responses that include timestamps — add a `timezone` field to the response so clients can display times correctly.
- `reminderService` — respect school timezone when determining whether it is a reasonable hour to send reminders.

### Schema Change

```js
// schoolModel.js
timezone: {
  type: String,
  default: 'UTC',
  trim: true,
  // Validated against a list of IANA timezone strings on save
},
```

### Acceptance Criteria

- [ ] `School` model has a `timezone` field (String, default `'UTC'`, validated as a valid IANA timezone identifier).
- [ ] `POST /api/schools` and `PATCH /api/schools/:slug` accept and persist a `timezone` value; invalid values return `400 VALIDATION_ERROR`.
- [ ] `reportService.aggregateByDate` passes the school's `timezone` to MongoDB's `$dateToString` so daily groupings reflect local dates.
- [ ] `reportService.getDashboardMetrics` computes "start of today" using the school's timezone.
- [ ] All payment API responses that include `confirmedAt` or `paymentDeadline` also include the school's `timezone` string so clients can render times correctly.
- [ ] A migration script (`backend/migrations/012_add_school_timezone.js`) backfills `timezone: 'UTC'` for all existing schools.
- [ ] Unit tests cover date grouping for a school in UTC+10 and UTC-5.
- [ ] Existing tests continue to pass.

---

## Issue 4: Payment memo is encrypted before being used as a Stellar memo — recipient wallets cannot match payments

**Labels:** `bug`, `critical`, `stellar-integration`

### Problem

`getPaymentInstructions` in `paymentController.js` returns an encrypted memo to the client:

```js
res.json({
  memo: encryptMemo(req.params.studentId),
  memoEncrypted: isEncryptionEnabled(),
  ...
});
```

When `MEMO_ENCRYPTION_KEY` is set, `encryptMemo` returns an AES-256-GCM ciphertext string. The parent is instructed to include this string as the Stellar transaction memo. However:

1. Stellar `MEMO_TEXT` is limited to **28 bytes**. An AES-GCM ciphertext (IV + tag + ciphertext, hex-encoded) is typically 80–100 characters — far exceeding the limit. The Stellar SDK will throw `MemoTooLongError` when the parent's wallet tries to build the transaction.
2. Even if the memo were short enough, `extractValidPayment` in `stellarService.js` reads `tx.memo` from the blockchain and passes it to `decryptMemo` before matching it to a student. But the memo on-chain is the **encrypted string** that the parent copied from the instructions — it was never the raw student ID. The decryption will either fail (wrong key) or return garbage, and no student will ever be matched.
3. The `createPaymentIntent` function generates a random 8-character hex memo and encrypts it, storing the encrypted value in `PaymentIntent.memo`. The same mismatch applies.

The memo encryption feature was designed to protect student IDs at rest in MongoDB (the `paymentModel` pre-save hook encrypts `memo` before writing to the database). It was incorrectly also applied to the **outbound** payment instructions, where the memo must be a plain-text student ID that the Stellar network and the backend's sync logic can read.

### Impact

- With `MEMO_ENCRYPTION_KEY` set, **no payment can ever be matched to a student**. The entire payment flow is broken.
- Parents receive a memo string that their Stellar wallet will reject as too long.
- This is a silent failure — the sync endpoint returns `{ message: "Sync complete" }` with zero matches and no error.

### Proposed Fix

`getPaymentInstructions` must return the **plain-text** student ID as the memo. Encryption at rest (in MongoDB) is handled by the `paymentModel` pre-save hook and should not affect what is shown to the user.

```js
// paymentController.js — getPaymentInstructions
res.json({
  memo: req.params.studentId,   // always plain text — Stellar memo must be readable
  memoEncrypted: false,
  ...
});
```

Remove `encryptMemo` from `getPaymentInstructions` and `createPaymentIntent`. The `memoEncrypted` field in the response should be removed or always set to `false` since the memo shown to the user is never encrypted.

### Acceptance Criteria

- [ ] `GET /api/payments/instructions/:studentId` returns `memo` equal to the plain-text `studentId`, regardless of whether `MEMO_ENCRYPTION_KEY` is set.
- [ ] `POST /api/payments/intent` stores the plain-text random memo in `PaymentIntent.memo`; the encrypted version is only written to MongoDB by the model's pre-save hook.
- [ ] The `memoEncrypted` field is removed from the payment instructions response (or documented as always `false`).
- [ ] A test asserts that with `MEMO_ENCRYPTION_KEY` set, the instructions endpoint still returns a plain-text memo ≤ 28 bytes.
- [ ] A test asserts that the memo stored in MongoDB (via the model hook) is different from the memo returned by the instructions endpoint when encryption is enabled.
- [ ] End-to-end payment flow test passes with encryption enabled.

---

## Issue 5: No authentication on student registration, fee structure creation, and school management endpoints

> **STATUS: RESOLVED (fixed before this audit was committed).** This audit was generated 2026-05-26, before the fix in `IMPLEMENTATION_SUMMARY.md` (2026-05-27, issue #562) landed. Every endpoint listed below now has `requireAdminAuth` applied in its route file (`studentRoutes.js`, `feeRoutes.js`, `schoolRoutes.js`, `paymentRoutes.js`). `tests/authentication-enforcement.test.js` exists and is substantial. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `security`, `critical`, `backend`

### Problem

The `requireAdminAuth` middleware exists in `backend/src/middleware/auth.js` and is applied to some routes (e.g. `GET /api/schools?includeInactive=true` has an inline JWT check). However, the following high-privilege endpoints have **no authentication** applied:

- `POST /api/students` — register a student
- `PUT/PATCH /api/students/:studentId` — update a student's name, class, or fee amount
- `DELETE /api/students/:studentId` — delete a student (hard delete + orphan payments)
- `POST /api/fees` — create a fee structure
- `PUT /api/fees/:className` — update a fee structure (with optional cascade to all students)
- `DELETE /api/fees/:className` — deactivate a fee structure
- `POST /api/schools` — create a new school tenant
- `PATCH /api/schools/:slug` — update school details including `stellarAddress`
- `DELETE /api/schools/:slug` — deactivate a school
- `POST /api/payments/sync` — trigger a blockchain sync
- `PATCH /api/payments/:txHash/status` — manually override payment status

Any unauthenticated actor on the network can:
- Register fake students and pollute the database.
- Change a school's `stellarAddress` to redirect all future payment instructions to an attacker-controlled wallet.
- Delete all students, causing all historical payments to be marked `studentDeleted: true` and excluded from reports.
- Trigger unlimited blockchain syncs, exhausting Horizon API rate limits.

### Proposed Fix

Apply `requireAdminAuth` to all write endpoints for students, fees, schools, and payment management. Read endpoints (`GET`) may remain public or be protected depending on the school's privacy requirements.

```js
// studentRoutes.js
router.post('/',    requireAdminAuth, registerStudent);
router.put('/:id',  requireAdminAuth, updateStudent);
router.delete('/:id', requireAdminAuth, deleteStudent);
```

A role-based access control (RBAC) model should be defined:
- `admin` role: full access to all endpoints.
- `staff` role (future): read access + payment sync, no school/fee management.
- Unauthenticated: read-only access to public endpoints (payment instructions, accepted assets).

### Acceptance Criteria

- [ ] `POST /api/students`, `PUT /api/students/:id`, `DELETE /api/students/:id` require a valid admin JWT; unauthenticated requests return `401`.
- [ ] `POST /api/fees`, `PUT /api/fees/:className`, `DELETE /api/fees/:className` require a valid admin JWT.
- [ ] `POST /api/schools`, `PATCH /api/schools/:slug`, `DELETE /api/schools/:slug` require a valid admin JWT.
- [ ] `POST /api/payments/sync` requires a valid admin JWT.
- [ ] `PATCH /api/payments/:txHash/status` requires a valid admin JWT (already partially implemented — verify it is enforced on the route level, not just in the controller).
- [ ] `GET` endpoints for students, fees, and payments remain accessible without authentication (or are documented as requiring auth if the school requires it).
- [ ] All existing tests are updated to include a valid JWT in requests that now require authentication.
- [ ] New tests assert that each protected endpoint returns `401` without a token and `403` with a non-admin token.
- [ ] The `README.md` and `docs/api-spec.md` are updated to document which endpoints require authentication.

---

## Issue 6: `deleteStudent` performs a hard delete — student record and payment history are permanently lost

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

`deleteStudent` in `studentController.js` calls `Student.findOneAndDelete(...)`, which **permanently removes** the student document from MongoDB:

```js
const student = await Student.findOneAndDelete({ schoolId: req.schoolId, studentId });
```

The `studentModel` has a `deletedAt` field and the `softDelete` utility is applied to the schema, which means soft-delete support is already built in. However, the delete controller bypasses it entirely and performs a hard delete.

Consequences:
1. The student's name, class, and fee history are permanently gone. There is no way to recover them.
2. Payments are marked `studentDeleted: true` and excluded from reports, but the payment records themselves still exist with a `studentId` that no longer resolves to a student document. This creates orphaned payment records that cannot be attributed to anyone.
3. Audit logs reference the deleted `studentId` but the student document is gone, making audit trails incomplete.
4. If a new student is registered with the same `studentId` (which is allowed after deletion), their payment history will be contaminated by the orphaned payments from the previous student.

### Proposed Fix

Replace the hard delete with a soft delete using the existing `softDelete` utility:

```js
// studentController.js — deleteStudent
const student = await Student.findOneAndUpdate(
  { schoolId: req.schoolId, studentId },
  { deletedAt: new Date() },
  { new: true }
);
```

All queries that list students should already filter `deletedAt: null` (the `softDelete` utility adds this automatically via a query middleware hook — verify this is working). The student record is preserved for audit purposes but excluded from active listings.

Additionally, prevent re-registration of a `studentId` that has been soft-deleted (or require explicit confirmation to reuse a deleted ID).

### Acceptance Criteria

- [ ] `DELETE /api/students/:studentId` sets `deletedAt` to the current timestamp instead of removing the document.
- [ ] Soft-deleted students do not appear in `GET /api/students` responses.
- [ ] Soft-deleted students do not appear in payment summary or report aggregations.
- [ ] `GET /api/students/:studentId` returns `404` for soft-deleted students.
- [ ] Attempting to register a new student with the same `studentId` as a soft-deleted student returns `409 DUPLICATE_STUDENT` (or a specific `STUDENT_PREVIOUSLY_DELETED` code with a clear message).
- [ ] Orphaned payments (where the student was previously hard-deleted) are handled gracefully — they remain in the database but are excluded from reports via the existing `studentDeleted` flag.
- [ ] A migration script backfills `deletedAt: null` for all existing student documents that do not have the field.
- [ ] Unit tests cover soft-delete, re-registration prevention, and exclusion from listings.
- [ ] The existing `tests/softDelete.test.js` is updated to cover the student delete endpoint.

---

## Issue 7: Currency conversion service has no fallback when CoinGecko is unavailable — fee display silently breaks

**Labels:** `enhancement`, `reliability`, `backend`

### Problem

`currencyConversionService.js` fetches live XLM/USDC prices from the CoinGecko API. When CoinGecko is unavailable (rate-limited, network outage, or API key expired), the service returns `{ available: false }` and all fiat-equivalent fields in API responses are `null`.

This is documented as "graceful degradation," but the current implementation has several gaps:

1. **No stale-cache fallback.** The in-memory cache is invalidated after `PRICE_CACHE_TTL_MS` (default 60 seconds). If CoinGecko is down for 5 minutes, the cache expires and all subsequent requests return `available: false` — even though a 5-minute-old rate would be far more useful than nothing.
2. **No persistent fallback.** On server restart, the cache is empty. If CoinGecko is down at startup, the first N requests all hit the API simultaneously (the in-flight deduplication helps, but only for concurrent requests within the same process tick).
3. **No alerting.** When the price feed fails, a `logger.warn` is emitted but there is no structured metric or health-check signal. The `/health` endpoint does not report price feed status.
4. **`getExchangeRates` endpoint returns `available: false` with no indication of when rates were last successfully fetched**, making it impossible for clients to decide whether to show a "rates unavailable" banner or use a cached value.

### Proposed Solution

1. **Stale-while-revalidate cache:** Keep the last successful rate in memory indefinitely. When a fresh fetch fails, return the stale rate with a `stale: true` flag and a `staleAge` field (seconds since last successful fetch). Clients can decide whether to display a staleness warning.
2. **Configurable stale threshold:** Add `PRICE_STALE_THRESHOLD_MS` env var (default: 1 hour). If the cached rate is older than this threshold, return `available: false` instead of the stale rate.
3. **Health check integration:** The `/health` endpoint should include `priceFeed: { available, lastFetchedAt, staleAge }`.
4. **`getExchangeRates` response enhancement:** Include `lastFetchedAt`, `stale`, and `staleAge` in the response.

### Acceptance Criteria

- [ ] When CoinGecko returns an error, `convertToLocalCurrency` returns the last successfully fetched rate with `stale: true` and `staleAge` (seconds) if the cached rate is within `PRICE_STALE_THRESHOLD_MS`.
- [ ] When the cached rate is older than `PRICE_STALE_THRESHOLD_MS`, `convertToLocalCurrency` returns `available: false`.
- [ ] `GET /api/payments/rates` response includes `lastFetchedAt`, `stale` (boolean), and `staleAge` (seconds) fields.
- [ ] `GET /health` includes a `priceFeed` subsystem with `available`, `lastFetchedAt`, and `staleAge`.
- [ ] `PRICE_STALE_THRESHOLD_MS` is documented in `README.md` and `backend/.env.example`.
- [ ] Unit tests cover: fresh fetch success, stale cache within threshold, stale cache beyond threshold, and concurrent request deduplication.
- [ ] Existing `tests/currencyConversion.test.js` tests continue to pass.

---

## Issue 8: Bulk student import (`POST /api/students/bulk`) processes rows sequentially — times out for large files

**Labels:** `performance`, `backend`

### Problem

`bulkImportStudents` in `studentController.js` processes CSV rows in a `for` loop with `await` inside:

```js
for (let i = 0; i < rows.length; i++) {
  // ...
  const student = await Student.create({ ... });
}
```

This is fully sequential — each row waits for the previous MongoDB insert to complete before starting. For a 10,000-row CSV (the configured maximum), this means 10,000 sequential round-trips to MongoDB. On a typical Atlas cluster with 5 ms round-trip latency, this takes **50 seconds** — well beyond the default 30-second HTTP timeout in most reverse proxies and load balancers.

Additionally:
1. The fee structure lookup (`FeeStructure.findOne`) is also inside the loop, causing up to 10,000 additional sequential queries even when all students are in the same class.
2. There is no progress reporting — the client receives no feedback until all rows are processed or the request times out.
3. If the request times out, partial imports leave the database in an inconsistent state with no way to resume.

### Proposed Solution

1. **Pre-fetch fee structures** for all unique class names before the loop (one query per unique class, not one per row).
2. **Batch inserts** using `Student.insertMany` with `ordered: false` so MongoDB processes the batch in parallel and individual failures do not abort the entire batch.
3. **Chunked processing** for very large files: process rows in chunks of 500, inserting each chunk with `insertMany`.
4. **Async job for files > 1,000 rows:** Return `202 Accepted` immediately with a job ID, process in the background, and expose a `GET /api/students/bulk/:jobId` status endpoint.

### Acceptance Criteria

- [ ] Bulk import of 1,000 students completes in under 5 seconds (measured in a test with a mocked MongoDB).
- [ ] Fee structures are fetched once per unique class name, not once per row.
- [ ] `Student.insertMany` (or equivalent batch operation) is used instead of per-row `Student.create`.
- [ ] Individual row failures (e.g. duplicate `studentId`) are reported in the response `details` array without aborting the entire import.
- [ ] Files with more than `CSV_MAX_ROWS` rows (default 10,000) are rejected with `400 CSV_TOO_MANY_ROWS` before any processing begins (already implemented — must be preserved).
- [ ] The response format is unchanged: `{ total, created, failed, details }`.
- [ ] Existing `tests/csvImportLimits.test.js` tests continue to pass.
- [ ] A new performance test asserts that 1,000-row import completes within the timeout.

---

## Issue 9: `reminderService` has no opt-out mechanism exposed via API — parents cannot unsubscribe from reminders

**Labels:** `feature`, `compliance`, `backend`

### Problem

The `Student` model has a `reminderOptOut` boolean field and `reminderService.isEligible` checks it:

```js
if (student.reminderOptOut) return false;
```

However, there is **no API endpoint** that allows a parent to set `reminderOptOut: true`. The only way to opt out is for a school administrator to directly update the student record via `PATCH /api/students/:studentId` — but `reminderOptOut` is not in the list of allowed update fields in `updateStudent`:

```js
const update = {};
if (name !== undefined) update.name = name;
if (className !== undefined) update.class = className;
if (feeAmount !== undefined) update.feeAmount = feeAmount;
// reminderOptOut is never set
```

This means:
1. Parents have no self-service way to stop receiving reminder emails.
2. School administrators cannot opt out a parent through the normal API.
3. In jurisdictions with anti-spam laws (CAN-SPAM, GDPR, etc.), the inability to unsubscribe from automated emails is a compliance violation.

### Proposed Solution

1. **Admin endpoint:** Add `reminderOptOut` to the allowed fields in `updateStudent` so administrators can toggle it.
2. **Self-service unsubscribe link:** Include a signed unsubscribe token in reminder emails. Add a public endpoint `GET /api/reminders/unsubscribe?token=<signed-token>` that sets `reminderOptOut: true` without requiring authentication.
3. **Re-subscribe endpoint:** `POST /api/students/:studentId/reminders/resubscribe` (admin-only) to re-enable reminders.

### Unsubscribe Token Design

The token should be a HMAC-SHA256 signature of `studentId:schoolId` using `JWT_SECRET`, with a 90-day expiry encoded in the token. This avoids storing tokens in the database.

### Acceptance Criteria

- [ ] `PATCH /api/students/:studentId` accepts `reminderOptOut: true/false` and persists it.
- [ ] Reminder emails include an unsubscribe link containing a signed token.
- [ ] `GET /api/reminders/unsubscribe?token=<token>` sets `reminderOptOut: true` for the identified student and returns a confirmation page (HTML) or JSON response.
- [ ] Expired or invalid unsubscribe tokens return `400` with a clear error message.
- [ ] `POST /api/students/:studentId/reminders/resubscribe` (admin-only) sets `reminderOptOut: false`.
- [ ] `reminderService.isEligible` continues to respect `reminderOptOut: true`.
- [ ] Unit tests cover token generation, token validation, expiry, and the unsubscribe endpoint.
- [ ] The reminder email template (`backend/src/templates/reminderEmail.html`) is updated to include the unsubscribe link.
- [ ] `docs/api-spec.md` is updated with the new endpoints.

---

## Issue 10: Webhook delivery has no replay protection — replayed webhooks can trigger duplicate actions in recipient systems

**Labels:** `security`, `backend`, `webhooks`

### Problem

`webhookService.js` signs outbound webhook payloads with HMAC-SHA256:

```js
headers['X-StellarEduPay-Signature'] = `sha256=${generateSignature(body, secret)}`;
```

The signature covers the payload content but **not a timestamp or nonce**. This means:

1. An attacker who intercepts a legitimate webhook delivery can **replay it** at any time. The signature will still be valid because the payload has not changed.
2. Recipient systems that verify the signature but do not check for replay attacks will process the same payment event multiple times (e.g. crediting a student's account twice).
3. There is no `X-Webhook-Delivery-ID` header, so recipients cannot use delivery IDs to deduplicate.

This is a well-known vulnerability in webhook implementations. GitHub, Stripe, and other major platforms address it by including a timestamp in the signed payload and requiring recipients to reject deliveries older than a configurable window (typically 5 minutes).

### Proposed Fix

1. **Include timestamp in signature:** Add a `X-StellarEduPay-Timestamp` header with the Unix timestamp (seconds). Include the timestamp in the HMAC input: `HMAC(timestamp + "." + JSON.stringify(body))`.
2. **Add delivery ID:** Add a `X-StellarEduPay-Delivery-ID` header with a UUID for each delivery attempt. Include this in the `WebhookRetry` model for deduplication.
3. **Document replay window:** Document that recipients should reject deliveries where `|now - timestamp| > 300` seconds (5 minutes).
4. **Update `verifySignature`:** Update the verification helper to accept and validate the timestamp.

### Acceptance Criteria

- [ ] Every webhook delivery includes `X-StellarEduPay-Timestamp` (Unix seconds) and `X-StellarEduPay-Delivery-ID` (UUID) headers.
- [ ] The HMAC signature is computed over `timestamp + "." + JSON.stringify(body)` so the timestamp is part of the signed content.
- [ ] `verifySignature(payload, signature, secret, timestamp)` validates both the HMAC and that `|now - timestamp| <= 300` seconds.
- [ ] The `WebhookRetry` model stores `deliveryId` for deduplication.
- [ ] Retry attempts use the **same** `deliveryId` as the original delivery (so recipients can deduplicate retries).
- [ ] `docs/WEBHOOK_INTEGRATION.md` is updated with the new signature format, timestamp header, and replay window guidance.
- [ ] Unit tests in `tests/webhookSignature.test.js` are updated to cover timestamp validation and replay rejection.
- [ ] Existing webhook tests continue to pass.

---

## Issue 11: `transactionQueue.js` in-memory queue is lost on server restart — submitted transactions are silently dropped

**Labels:** `bug`, `reliability`, `backend`

### Problem

`backend/src/queue/transactionQueue.js` implements an in-memory queue for processing submitted Stellar transactions. When the server restarts (deployment, crash, OOM kill), all jobs in the queue are lost. Any transaction that was submitted to the Stellar network but not yet verified will never be verified, and the associated payment record will remain in `SUBMITTED` status indefinitely.

The `transactionRetryQueue.js` uses BullMQ (Redis-backed) for the retry queue, which is durable. But the primary transaction queue is in-memory only.

Additionally, there is no background job that scans for payments stuck in `SUBMITTED` status and re-queues them for verification. A payment can be stuck in `SUBMITTED` forever if the server restarts between submission and verification.

### Proposed Solution

1. **Persist the transaction queue to Redis** using BullMQ (already a dependency via `bullMQRetryService.js`). This makes the queue durable across restarts.
2. **Add a startup reconciliation job** that runs once on server start, finds all payments in `SUBMITTED` status older than 5 minutes, and re-queues them for verification.
3. **Add a `GET /api/payments/stuck` endpoint** (admin-only) that lists payments in `SUBMITTED` status older than a configurable threshold, for manual inspection.

### Acceptance Criteria

- [ ] The transaction queue is backed by Redis (BullMQ) when `REDIS_HOST` is configured; falls back to in-memory when Redis is not available (with a startup warning).
- [ ] On server startup, payments in `SUBMITTED` status older than `STUCK_PAYMENT_THRESHOLD_MS` (default: 5 minutes, configurable) are automatically re-queued for verification.
- [ ] `GET /api/payments/stuck` (admin-only) returns payments in `SUBMITTED` status older than the threshold.
- [ ] The startup reconciliation job is logged at `info` level with the count of re-queued payments.
- [ ] Unit tests cover: queue persistence across simulated restart, startup reconciliation, and the stuck payments endpoint.
- [ ] `README.md` documents the Redis dependency for durable queue support.
- [ ] Existing `tests/transactionQueueDurability.test.js` tests are updated to cover the new behavior.

---

## Issue 12: `GET /api/payments` (all payments) does not filter out soft-deleted payments — deleted records appear in results

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

`getAllPayments` in `paymentController.js` filters out payments where `studentDeleted: true` but does not filter out payments where `deletedAt` is set (soft-deleted payments):

```js
const filter = { schoolId, studentDeleted: { $ne: true } };
```

The `Payment` model has a `deletedAt` field and the `softDelete` utility is applied to the schema. However, the `softDelete` utility adds a query middleware hook that automatically appends `{ deletedAt: null }` to `find` queries — but only when using the Mongoose model's query methods directly. When `Payment.find(filter)` is called with an explicit filter object, the soft-delete middleware may not apply correctly depending on the Mongoose version and how the middleware is registered.

Additionally, `getStudentPayments` and `getStudentBalance` do not explicitly filter `deletedAt: null`, relying entirely on the middleware hook.

### Proposed Fix

Explicitly add `deletedAt: null` to all payment query filters to ensure soft-deleted records are never returned, regardless of middleware behavior:

```js
const filter = {
  schoolId,
  studentDeleted: { $ne: true },
  deletedAt: null,
};
```

Audit all payment query sites (`getAllPayments`, `getStudentPayments`, `getStudentBalance`, `getOverpayments`, `getSuspiciousPayments`, `getPendingPayments`, `reportService`) and add explicit `deletedAt: null` filters.

### Acceptance Criteria

- [ ] `GET /api/payments` does not return payments where `deletedAt` is set.
- [ ] `GET /api/payments/:studentId` does not return soft-deleted payments.
- [ ] `GET /api/payments/:studentId/balance` excludes soft-deleted payments from the total paid calculation.
- [ ] Report aggregations in `reportService.js` exclude soft-deleted payments.
- [ ] A test creates a payment, soft-deletes it, and asserts it does not appear in any of the above endpoints.
- [ ] The `softDelete` utility's query middleware is tested to confirm it applies correctly to all query types used in the codebase.
- [ ] Existing payment tests continue to pass.

---

## Issue 13: No rate limiting on `POST /api/students/bulk` — allows denial-of-service via large CSV uploads

**Labels:** `security`, `backend`, `rate-limiting`

### Problem

`POST /api/students/bulk` accepts CSV files up to 5 MB (`CSV_MAX_SIZE_BYTES`) with up to 10,000 rows (`CSV_MAX_ROWS`). The endpoint is subject only to the general rate limiter (100 requests per 15 minutes), which means an attacker can:

1. Upload 100 × 10,000-row CSVs in 15 minutes = 1,000,000 student creation attempts.
2. Each upload triggers up to 10,000 sequential MongoDB queries (fee structure lookups + inserts), saturating the database.
3. The CSV parsing itself is CPU-intensive for large files; 100 concurrent large uploads can exhaust Node.js's single-threaded event loop.

Additionally, there is no authentication on this endpoint (see Issue 5), so the attack requires no credentials.

### Proposed Fix

1. **Dedicated rate limiter** for bulk import: maximum 5 requests per hour per IP.
2. **Authentication required** (see Issue 5): only admin users can perform bulk imports.
3. **File size validation before parsing:** Reject files larger than `CSV_MAX_SIZE_BYTES` before calling `parseCsvBuffer` (already implemented — verify it runs before the stream is opened).
4. **Async processing for large files:** Files with more than 500 rows should be processed asynchronously (return `202 Accepted` with a job ID).

### Acceptance Criteria

- [ ] `POST /api/students/bulk` is protected by a dedicated rate limiter: maximum 5 requests per hour per IP.
- [ ] Requests exceeding the rate limit return `429` with `code: RATE_LIMIT_EXCEEDED`.
- [ ] The endpoint requires admin authentication (see Issue 5).
- [ ] File size is validated before the CSV stream is opened; oversized files return `413` immediately.
- [ ] A test asserts that the 6th bulk import request within an hour returns `429`.
- [ ] Existing `tests/csvImportLimits.test.js` tests continue to pass.

---

## Issue 14: `feeController.updateFeeStructure` with `cascadeToStudents: true` does not recalculate `remainingBalance` correctly

**Labels:** `bug`, `data-integrity`, `backend`

### Problem

When `PUT /api/fees/:className` is called with `cascadeToStudents: true`, the controller updates all students in the class:

```js
const result = await Student.updateMany(
  { schoolId: req.schoolId, class: className, deletedAt: null },
  { feeAmount, remainingBalance: null }
);
```

Setting `remainingBalance: null` is incorrect. The remaining balance should be recalculated as `feeAmount - totalPaid` for each student. Setting it to `null` means:

1. `GET /api/students/:studentId` returns `remainingBalance: null` until the student's next payment or the next time their document is saved (which triggers the pre-save hook that recalculates it).
2. `getStudentBalance` in `paymentController.js` computes remaining balance from the aggregated payment total, so it is correct — but the `Student` document itself has stale/null data.
3. The `isOverdue` virtual depends on `feePaid`, which is not updated by the cascade. A student who had fully paid the old fee amount may now be marked as unpaid after a fee increase.

### Proposed Fix

Replace the `updateMany` with a per-student update that recalculates `remainingBalance` and `feePaid`:

```js
const students = await Student.find({ schoolId: req.schoolId, class: className, deletedAt: null });
for (const student of students) {
  student.feeAmount = feeAmount;
  student.remainingBalance = Math.max(0, feeAmount - (student.totalPaid || 0));
  student.feePaid = (student.totalPaid || 0) >= feeAmount;
  await student.save(); // triggers pre-save hook for fees array sync
}
```

For large classes, this should be done in batches to avoid memory issues.

### Acceptance Criteria

- [ ] After `PUT /api/fees/:className` with `cascadeToStudents: true`, all students in the class have correct `feeAmount`, `remainingBalance`, and `feePaid` values.
- [ ] A student who had `totalPaid >= oldFeeAmount` (fully paid) and `newFeeAmount > oldFeeAmount` has `feePaid: false` and `remainingBalance: newFeeAmount - totalPaid` after the cascade.
- [ ] A student who had `totalPaid >= oldFeeAmount` and `newFeeAmount <= totalPaid` remains `feePaid: true`.
- [ ] `remainingBalance` is never `null` after a cascade update.
- [ ] The cascade is performed in batches of 500 students to avoid memory issues for large classes.
- [ ] Unit tests cover all three scenarios above (fee increase, fee decrease, no change).
- [ ] Existing `tests/feeStructureUpdate.test.js` tests continue to pass.

---

## Issue 15: Health check endpoint does not verify Stellar Horizon connectivity — reports healthy when blockchain is unreachable

**Labels:** `enhancement`, `observability`, `backend`

### Problem

`GET /health` is implemented in `healthController.js`. Based on the README, it returns:
- `200 { status: "ok" }` when all systems are healthy.
- `200 { status: "degraded" }` when a subsystem is unreachable.
- `503 { status: "unhealthy" }` when MongoDB is disconnected.

However, the health check does not verify Stellar Horizon connectivity. If the Horizon API is unreachable (network partition, Stellar network outage, rate limit), the health endpoint still returns `200 ok` even though:
- `POST /api/payments/verify` will fail for all new transactions.
- `POST /api/payments/sync` will fail.
- Background polling will silently stop matching payments.

This means load balancers and uptime monitors will not detect a Stellar outage, and the system will appear healthy while payments are not being processed.

### Proposed Fix

Add a Stellar Horizon connectivity check to the health endpoint:

```js
// healthController.js
async function checkStellarHealth() {
  try {
    await withStellarRetry(() => server.ledgers().limit(1).call(), { label: 'healthCheck', maxRetries: 1 });
    return { status: 'ok', latencyMs: /* measured */ };
  } catch (err) {
    return { status: 'unreachable', error: err.message };
  }
}
```

The Stellar check should have a short timeout (3 seconds) and should not retry on failure (to keep the health check fast). If Stellar is unreachable, the overall status should be `degraded` (not `unhealthy`, since MongoDB is still up and cached data can be served).

### Acceptance Criteria

- [ ] `GET /health` includes a `stellar` subsystem in the response: `{ status: 'ok' | 'unreachable', latencyMs?, error? }`.
- [ ] When Stellar Horizon is unreachable, `GET /health` returns `200 { status: "degraded", details: { stellar: { status: "unreachable" } } }`.
- [ ] The Stellar health check has a maximum timeout of 3 seconds and does not retry.
- [ ] The Stellar health check does not count against Horizon rate limits (use a lightweight endpoint like `GET /` or `GET /ledgers?limit=1`).
- [ ] `GET /health` response time is under 5 seconds even when Stellar is unreachable (due to the 3-second timeout).
- [ ] Unit tests in `tests/health.test.js` cover: all healthy, Stellar unreachable (degraded), MongoDB disconnected (unhealthy).
- [ ] `README.md` monitoring section is updated to document the `stellar` subsystem in the health response.

---

## Issue 16: `auditLogModel.js` has a TTL index but no pagination on `GET /api/audit-logs` — large audit logs cause memory exhaustion

**Labels:** `performance`, `backend`, `observability`

### Problem

`GET /api/audit-logs` in `auditController.js` fetches audit log entries. The `AuditLog` model has a TTL index to expire old entries, but:

1. There is no pagination on the audit log endpoint — it returns all matching records in a single response.
2. A busy school with many payment verifications can accumulate thousands of audit log entries per day. Fetching all of them in one request loads the entire result set into Node.js memory before serializing to JSON.
3. The frontend `audit-logs.jsx` page loads all audit logs at once, which can cause the browser to freeze for large datasets.

The `.kiro/specs/audit-log-pagination/` spec directory exists, indicating this was planned but not implemented.

### Proposed Solution

Implement cursor-based or offset-based pagination on the audit log endpoint, consistent with the pagination pattern used by `getAllPayments` and `getStudentPayments`.

```
GET /api/audit-logs?page=1&limit=50&action=payment_verify&startDate=2026-01-01&endDate=2026-12-31
```

Response:
```json
{
  "logs": [...],
  "pagination": { "page": 1, "limit": 50, "total": 1234, "totalPages": 25 }
}
```

### Acceptance Criteria

- [ ] `GET /api/audit-logs` supports `page` (default 1) and `limit` (default 50, max 200) query parameters.
- [ ] `GET /api/audit-logs` supports filtering by `action`, `startDate`, `endDate`, `result` (`success`/`failure`), and `performedBy`.
- [ ] The response includes a `pagination` object with `page`, `limit`, `total`, and `totalPages`.
- [ ] The endpoint never loads more than `limit` documents into memory at once (uses `.skip().limit()` or cursor-based pagination).
- [ ] The frontend `audit-logs.jsx` page is updated to use paginated loading with a "Load more" button or page navigation.
- [ ] The `.kiro/specs/audit-log-pagination/tasks.md` tasks are completed.
- [ ] Unit tests cover pagination, filtering, and boundary cases (empty results, last page).
- [ ] Existing audit log tests continue to pass.

---

## Issue 17: `paymentModel` pre-save hook blocks status transitions from `SUCCESS` or `FAILED` — legitimate admin overrides are rejected

**Labels:** `bug`, `backend`

### Problem

The `paymentModel` pre-save hook enforces immutability for payments in `SUCCESS` or `FAILED` status:

```js
if (originalStatus === 'SUCCESS' || originalStatus === 'FAILED') {
  return next(new Error('Payment audit trail is immutable once in SUCCESS or FAILED state'));
}
```

However, `updatePaymentStatus` in `paymentController.js` allows the transition `SUCCESS → DISPUTED`:

```js
const ALLOWED_TRANSITIONS = {
  SUCCESS: ['DISPUTED'],
  PENDING: ['FAILED'],
  SUBMITTED: ['FAILED'],
};
```

This transition is legitimate — an admin needs to mark a payment as disputed after it has been confirmed. But the pre-save hook will block it because the original status is `SUCCESS`.

The controller uses `findOneAndUpdate` (not `save`), which bypasses Mongoose pre-save hooks. So the transition currently works — but only because it bypasses the hook. This is fragile: any future refactor that switches to `save()` will silently break admin dispute flagging.

Additionally, the `FAILED → SUCCESS` transition is not allowed by `ALLOWED_TRANSITIONS`, but the pre-save hook would block it anyway. The two mechanisms are inconsistent and the interaction is not documented.

### Proposed Fix

1. **Remove the blanket immutability check** from the pre-save hook. Immutability should be enforced at the controller/service layer where business rules are defined, not in the model.
2. **Add a model-level validator** that only blocks transitions not in `ALLOWED_TRANSITIONS` (or a superset of it).
3. **Document the transition rules** in a comment in `paymentModel.js`.
4. Alternatively, keep the pre-save hook but add an explicit exception for `SUCCESS → DISPUTED`.

### Acceptance Criteria

- [ ] `PATCH /api/payments/:txHash/status` with `{ status: "DISPUTED" }` on a `SUCCESS` payment succeeds and returns the updated payment.
- [ ] `PATCH /api/payments/:txHash/status` with an invalid transition (e.g. `FAILED → SUCCESS`) returns `400 INVALID_TRANSITION`.
- [ ] The pre-save hook and the controller's `ALLOWED_TRANSITIONS` are consistent — they enforce the same rules.
- [ ] A unit test covers the `SUCCESS → DISPUTED` transition via both `findOneAndUpdate` and `save()`.
- [ ] A unit test asserts that `FAILED → SUCCESS` is rejected.
- [ ] Existing `tests/updatePaymentStatus.test.js` tests continue to pass.

---

## Issue 18: `generateStudentId` does not guarantee uniqueness across schools — collisions are possible

**Labels:** `bug`, `backend`

### Problem

`backend/src/utils/generateStudentId.js` generates a student ID (used when `studentId` is not provided in the registration request). The implementation generates a random or sequential ID but does not check for uniqueness across all schools — it only checks within the current school (via the unique compound index `{ studentId: 1, schoolId: 1 }`).

While the compound index prevents duplicate `studentId` within a school, the `generateStudentId` function may generate an ID that already exists in the same school, causing a `DUPLICATE_STUDENT` error that is surfaced to the caller as an unexpected failure rather than being retried transparently.

Looking at `tests/generateStudentId.test.js`, the function appears to generate IDs without a retry loop. If the generated ID collides with an existing one, `registerStudent` will throw a `11000` duplicate key error, which is caught and returned as `409 DUPLICATE_STUDENT` — but the caller asked for an auto-generated ID, so they have no way to resolve this without retrying the entire registration.

### Proposed Fix

1. **Add a retry loop** in `generateStudentId` that checks for existence and regenerates if a collision is detected (up to 5 attempts).
2. **Use a higher-entropy ID format** to reduce collision probability (e.g. `STU-<timestamp-base36>-<4-random-hex-chars>`).
3. **Document the ID format** and its uniqueness guarantees.

### Acceptance Criteria

- [ ] `generateStudentId` retries up to 5 times if the generated ID already exists in the school.
- [ ] After 5 failed attempts, it throws a descriptive error (`STUDENT_ID_GENERATION_FAILED`) rather than a generic duplicate key error.
- [ ] The generated ID format is documented in a comment.
- [ ] The generated ID is ≤ 28 characters (Stellar memo limit, enforced by the `studentId` field's `maxlength` validator).
- [ ] Unit tests cover: successful generation, single collision with retry, and exhausted retries.
- [ ] Existing `tests/generateStudentId.test.js` tests continue to pass.

---

## Issue 19: Frontend `dashboard.jsx` fetches all students without pagination — page freezes for schools with many students

**Labels:** `performance`, `frontend`

### Problem

`frontend/src/pages/dashboard.jsx` fetches the student list from `GET /api/students`. The backend now supports pagination (`page`, `limit` query params), but the frontend does not use it — it fetches all students in a single request (defaulting to the backend's default of 50, but with no UI for loading more).

For schools with hundreds of students, the dashboard either:
1. Shows only the first 50 students with no indication that more exist (silent data truncation).
2. If the limit is raised, loads all students into memory and renders a very long list, causing browser jank.

Additionally, the dashboard's payment summary table (`getPaymentSummary` in `studentController.js`) fetches all students and all payments in memory to compute the summary — this is an O(n) memory operation that will degrade as the school grows.

### Proposed Solution

1. **Paginate the student list** in the dashboard: show 20 students per page with previous/next navigation.
2. **Add search and filter controls** to the dashboard (the backend already supports `?search=`, `?class=`, `?status=` filters).
3. **Use the server-side `getPaymentSummary` endpoint** instead of computing the summary client-side.
4. **Virtualize the student list** for very large schools (optional, lower priority).

### Acceptance Criteria

- [ ] The dashboard student list is paginated: 20 students per page with page navigation controls.
- [ ] The dashboard shows the total student count and current page range (e.g. "Showing 1–20 of 347 students").
- [ ] Search by name or student ID is supported via the `?search=` query parameter.
- [ ] Filter by payment status (`paid`, `unpaid`, `partial`) is supported via the `?status=` query parameter.
- [ ] Filter by class is supported via the `?class=` query parameter.
- [ ] The dashboard does not load more than `limit` student records into memory at once.
- [ ] Page navigation is accessible (keyboard-navigable, ARIA labels on pagination controls).
- [ ] Unit tests in `tests/student.test.js` cover the paginated student list response shape.
- [ ] The frontend renders correctly when the student list is empty.

---

## Issue 20: No end-to-end test covers the full payment flow from payment intent creation to blockchain sync

**Labels:** `testing`, `quality`

### Problem

The test suite has separate unit tests for individual components (Stellar service, payment limits, student CRUD) but no single test that exercises the complete payment flow:

1. Create a school and student.
2. Create a payment intent.
3. Submit a transaction (mocked Stellar network).
4. Verify the transaction hash.
5. Confirm the payment is recorded with correct `feeValidationStatus`.
6. Sync payments from the blockchain.
7. Assert the student's `feePaid` status is updated.

`tests/e2e-payment-flow.test.js` exists but based on the file size (16 KB) it may not cover all steps, particularly the sync flow and the interaction between `PaymentIntent`, `Payment`, and `Student` models.

Without a full end-to-end test, regressions in the payment flow (like Issue 1's double-sync bug or Issue 4's memo encryption bug) can be introduced without any test failing.

### Proposed Solution

Write a comprehensive end-to-end test that:
- Uses an in-memory MongoDB (via `mongodb-memory-server`).
- Mocks the Stellar SDK (`@stellar/stellar-sdk`) to return controlled transaction data.
- Exercises every step of the payment flow.
- Covers edge cases: overpayment, underpayment, duplicate transaction, expired payment intent, missing memo.

### Acceptance Criteria

- [ ] A test file `tests/e2e-payment-flow.test.js` (or an update to the existing one) covers all 7 steps listed above.
- [ ] The test covers the following scenarios:
  - Exact payment (valid)
  - Overpayment (overpaid)
  - Underpayment (rejected with `UNDERPAID`)
  - Duplicate transaction hash (rejected with `DUPLICATE_TX`)
  - Missing memo (rejected with `MISSING_MEMO`)
  - Expired payment intent (rejected with `INTENT_EXPIRED`)
  - Sync flow: new transaction on blockchain is matched to student and updates `feePaid`
- [ ] All tests use mocked Stellar SDK — no real network calls.
- [ ] Tests run in under 30 seconds total.
- [ ] The test file is included in the CI workflow.
- [ ] All existing tests continue to pass.

---

*End of issues.md — 20 issues total.*
