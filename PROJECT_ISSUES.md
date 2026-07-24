# StellarEduPay — Engineering Backlog (150 Issues)

> Consolidated, de-duplicated issue backlog generated from a full codebase audit on **2026-06-24**.
> Each issue is self-contained: **Problem → Impact → Proposed Fix → Acceptance Criteria**.
> Issues **#1–#25** are the previously-tracked items (cleaned and de-duplicated from `GITHUB_ISSUES.md` / `issues.md`).
> Issues **#26–#150** are new findings spanning security, multi-tenancy, Stellar integration, payments, reliability, reporting, frontend, observability, performance, testing, DevOps, and compliance.
>
> **Label legend:** `critical` `bug` `security` `enhancement` `feature` `tech-debt` `performance` `multi-school` `stellar-integration` `backend` `frontend` `devops` `testing` `docs` `observability` `data-integrity` `compliance`

## Index

- **Security & Authentication:** 5, 10, 13, 26–40
- **Multi-Tenancy & Isolation:** 2, 24, 41–48
- **Stellar / Blockchain Integration:** 4, 15, 49–60
- **Payment Lifecycle & Idempotency:** 1, 11, 12, 17, 18, 23, 61–72
- **Webhooks & Notifications:** 10, 73–80
- **Reliability, Queues & Retries:** 11, 81–90
- **Reports & Analytics:** 16, 21, 22, 91–98
- **Currency & Pricing:** 7, 99–104
- **Disputes:** 105–110
- **Fees & Adjustments:** 14, 25, 111–116
- **Reminders & Email:** 9, 117–121
- **Observability & Metrics:** 122–128
- **Performance & Scaling:** 8, 19, 129–134
- **Data Model & Migrations:** 3, 6, 135–139
- **Frontend:** 19, 140–145
- **Testing & CI:** 20, 146–148
- **DevOps & Documentation:** 149–150

---

## Issue #1: `syncAllPayments` calls `syncPaymentsForSchool` twice and sends two HTTP responses

> **STATUS: RESOLVED (fixed before this backlog was compiled).** This is one of the "#1-25 previously-tracked items... de-duplicated from `GITHUB_ISSUES.md`/`issues.md`" per this document's own header — carried forward from the 2026-05-26 pre-fix audit without re-verification, not independently re-checked on 2026-06-24. Current code has moved to `backend/src/controllers/paymentAdminController.js` and calls `syncPaymentsForSchool`/`res.json` exactly once. Independently re-confirmed by `CHANGELOG.md` issue #731. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `bug`, `critical`, `backend`

### Problem
In `backend/src/controllers/paymentController.js`, the `syncAllPayments` handler calls `syncPaymentsForSchool(req.school)` **twice** — once before `res.json(...)` and once after — and calls `res.json(...)` **twice**. The second response is written to an already-closed socket, producing `Cannot set headers after they are sent`.

### Impact
- Every manual sync triggers two full blockchain polling cycles, doubling Horizon usage and Mongo writes.
- Possible duplicate payment records if the idempotency check has a race window.
- Log pollution masks real errors; the process can crash under some configs.
- The audit log records the *second* (discarded) sync's result, not the one returned to the caller.

### Proposed Fix
Call the service once, log the audit, and send one response inside a `try/finally` that always releases the `_syncLocks` entry. Wrap thrown errors with `wrapStellarError` and forward via `next`.

### Acceptance Criteria
- `syncPaymentsForSchool` is invoked exactly once per `POST /api/payments/sync`.
- `res.json` is invoked exactly once; no "headers already sent" errors in logs.
- Audit entry captures the single sync summary.
- `_syncLocks` is always cleaned up in `finally`.
- A unit test asserts a single service invocation per request.

---

## Issue #2: `GET /api/payments/:studentId` lacks cross-school isolation tests

> **STATUS: RESOLVED (fixed before this backlog was compiled).** Carried forward from the 2026-05-26 pre-fix audit without re-verification (see this document's header note on issues #1-25). Current code (`backend/src/controllers/paymentQueryController.js`) scopes the student lookup, payment find/count, and both balance aggregations by `schoolId`. `tests/cross-school-isolation.test.js` and `backend/tests/cross-school-isolation.test.js` exist and are substantial. Note: the separate, still-open issue is that `resolveSchool` trusts the `X-School-ID`/`X-School-Slug` header alone on read endpoints when no JWT is present — a different problem from this one. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `bug`, `security`, `multi-school`, `testing`

### Problem
`getStudentPayments` filters on `schoolId + studentId`, but `studentId` is only unique *within* a school. There are no integration tests asserting that School A cannot read School B's payments when both have a student `STU001`. The balance and instructions endpoints share the same exposure.

### Impact
A future refactor that drops the `schoolId` filter would leak cross-tenant payment data and pass CI undetected — a severe multi-tenant data breach.

### Proposed Fix
Add `tests/cross-school-isolation.test.js` seeding two schools with overlapping `studentId`s, asserting `404`/empty results across tenants for payments, balance, and instructions endpoints. Add a guard middleware that rejects any request reaching a tenant-scoped handler without `req.schoolId`.

### Acceptance Criteria
- `GET /api/payments/:studentId` returns `404` when the student belongs to another school.
- `GET /api/payments/:studentId/balance` returns `404` under the same condition.
- At least 5 cross-tenant test cases added.
- `resolveSchool` is applied to every payment/student route.

---

## Issue #3: `School` model `timezone` handling is incomplete across reporting and scheduling

**Labels:** `enhancement`, `multi-school`, `data-integrity`

### Problem
Although a `timezone` field exists (migration `013_add_school_timezone.js`), several code paths still group/compute dates in server-UTC: `reportService.aggregateByDate`, dashboard "today" metrics, and reminder windows. A UTC+10 school sees late-evening payments grouped on the wrong calendar day.

### Impact
Daily/weekly report buckets and "today's payments" counters are wrong for any non-UTC school; reminders may fire outside business hours.

### Proposed Fix
Thread the school's IANA `timezone` into MongoDB `$dateToString`/`$dateTrunc` `timezone` options for every date aggregation, into start-of-day computation for dashboards, and into reminder scheduling windows. Validate the IANA string on write.

### Acceptance Criteria
- All report date grouping uses the school timezone.
- Dashboard "today" boundaries use the school timezone.
- Invalid IANA strings rejected with `400`.
- Tests cover a UTC+10 and a UTC−5 school crossing midnight.

---

## Issue #4: Confirm payment memo is plaintext student ID end-to-end

**Labels:** `bug`, `critical`, `stellar-integration`

### Problem
Stellar `MEMO_TEXT` is limited to 28 bytes. If `getPaymentInstructions` ever returns an encrypted memo (AES-GCM ciphertext is 80–100+ chars), wallets throw `MemoTooLongError`, and on-chain matching in `extractValidPayment` fails because the chain memo is ciphertext, not the raw student ID. Encryption-at-rest must be a model concern only.

### Impact
With memo encryption enabled the entire payment-matching flow silently breaks — payments are never reconciled to students.

### Proposed Fix
Guarantee `getPaymentInstructions` returns the plaintext student ID as the memo. Keep `paymentModel` pre-save encryption for storage only. Add a test asserting the returned memo ≤ 28 bytes and equal to the student ID.

### Acceptance Criteria
- Returned memo equals the plaintext `studentId` and is ≤ 28 bytes.
- On-chain matching succeeds with encryption-at-rest enabled.
- Regression test added.

---

## Issue #5: Write endpoints for students, fees, and schools have no authentication

> **STATUS: RESOLVED (fixed before this backlog was compiled).** Carried forward from the 2026-05-26 pre-fix audit without re-verification (see this document's header note on issues #1-25). Every endpoint listed below now has `requireAdminAuth` applied in its route file. `tests/authentication-enforcement.test.js` exists and is substantial. See `SECURITY_STATUS_RECONCILIATION.md`.

**Labels:** `security`, `critical`, `backend`

### Problem
Mutating routes (student create/update/delete, fee structure create/update, school create/update) are reachable without admin auth in several route files. Only some admin routes apply `requireAdminAuth`.

### Impact
Anyone who can reach the API can create/delete students, rewrite fee structures, and reconfigure schools — full tenant takeover.

### Proposed Fix
Apply `requireAdminAuth` (and tenant scoping) to every mutating route. Add a route-coverage test that enumerates the router stack and asserts no mutating handler is unauthenticated.

### Acceptance Criteria
- All POST/PUT/PATCH/DELETE routes require auth.
- A test fails if any mutating route lacks the auth middleware.

---

## Issue #6: `deleteStudent` performs a hard delete — history is permanently lost

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
`deleteStudent` removes the student document outright, orphaning payment history and breaking audit/reporting references.

### Impact
Irreversible loss of financial/audit history; reports referencing the student break; violates retention expectations for payment data.

### Proposed Fix
Convert to soft delete (`deletedAt`, using `utils/softDelete.js`), exclude soft-deleted records from default queries, and provide an admin restore path. Backfill via a migration (see `010`/`012`).

### Acceptance Criteria
- `DELETE` sets `deletedAt` instead of removing the document.
- Default queries exclude soft-deleted students.
- Payment history remains queryable for audits.
- Restore endpoint exists and is audited.

---

## Issue #7: Currency conversion relies on a single price provider with no failover

**Labels:** `enhancement`, `backend`, `observability`

### Problem
`currencyConversionService.js` now implements stale-while-revalidate, but still depends solely on CoinGecko, logs via `console.warn` (not the structured `logger`), and the in-memory cache is per-process (not shared across replicas, so each replica hammers CoinGecko independently).

### Impact
A CoinGecko outage longer than `PRICE_STALE_THRESHOLD_MS` makes all fiat display unavailable; rate-limit bans are likely under horizontal scaling; price-feed failures are invisible to log aggregation.

### Proposed Fix
Add a secondary provider (e.g. Stellar DEX / Coinbase) behind a provider interface, move logging to `logger.child('CurrencyConversion')`, and back the cache with Redis so replicas share a single fetch. Emit a metric for feed availability and staleness.

### Acceptance Criteria
- Secondary provider used when primary fails.
- All logging structured via `logger`.
- Cross-replica shared cache when `REDIS_HOST` is set.
- `price_feed_available` / `price_feed_staleness_seconds` metrics exported.

---

## Issue #8: Bulk student import processes rows sequentially — times out for large CSVs

**Labels:** `performance`, `backend`

### Problem
`POST /api/students/bulk` inserts rows one-by-one in a loop, so a multi-thousand-row CSV exceeds the request timeout and partially applies.

### Impact
Large onboarding imports fail midway, leaving inconsistent state and no clear resumption point.

### Proposed Fix
Switch to batched `insertMany` with `ordered: false`, validate the whole file first, return a structured per-row error report, and move very large imports to an async job with a status endpoint.

### Acceptance Criteria
- 5,000-row import completes within the request budget or runs async with status polling.
- Per-row validation errors returned without aborting the batch.
- Partial failures are reported, not silently dropped.

---

## Issue #9: `reminderService` has no parent opt-out / unsubscribe path

**Labels:** `feature`, `compliance`, `backend`

### Problem
Reminder emails have no unsubscribe mechanism exposed via API, despite `utils/unsubscribeToken.js` existing. This risks anti-spam/compliance violations.

### Impact
Parents cannot opt out; deliverability and legal/compliance exposure (CAN-SPAM/GDPR-style requirements).

### Proposed Fix
Add a signed unsubscribe token to every reminder email and a `GET /api/reminders/unsubscribe?token=...` endpoint that flips an opt-out flag on the student/guardian. Honor the flag in `reminderService`.

### Acceptance Criteria
- Every reminder email contains a working unsubscribe link.
- Unsubscribed recipients are excluded from future reminders.
- Token is signed, single-purpose, and expires.

---

## Issue #10: Webhook delivery has no replay protection on the receiver side

**Labels:** `security`, `backend`

### Problem
Outbound webhooks are HMAC-signed and carry `X-StellarEduPay-Timestamp` and `X-StellarEduPay-Delivery-ID` (see `webhookService.js`), but there is no documented receiver-side verification requiring timestamp freshness + delivery-ID dedup, and no inbound webhook replay guard for any callbacks the system itself accepts.

### Impact
An intercepted delivery can be replayed against a receiver indefinitely, and any inbound webhook lacks nonce/timestamp validation.

### Proposed Fix
Document and enforce a verification contract: reject deliveries with a timestamp skew beyond N minutes, dedupe on `Delivery-ID`. For inbound webhooks, validate signature + timestamp + store seen delivery IDs with TTL.

### Acceptance Criteria
- Timestamp-skew rejection implemented/documented with a tested example verifier.
- Delivery-ID dedup store with TTL.
- Replay test proves a re-sent delivery is rejected.

---

## Issue #11: In-memory transaction queue state is lost on restart

**Labels:** `bug`, `critical`, `data-integrity`

### Problem
`queue/transactionQueue.js` holds submitted-transaction state in memory. On restart, transactions in `SUBMITTED` status have no in-memory tracker, so they are neither polled to completion nor retried.

### Impact
Real on-chain submissions get stuck in `SUBMITTED` forever; funds may move while the record never reaches `SUCCESS`.

### Proposed Fix
Persist submission state (BullMQ + Redis, already a dependency) so a restart rehydrates in-flight submissions; on boot, reconcile `SUBMITTED` records against Horizon (see `stuckPaymentReconciliation.js`).

### Acceptance Criteria
- In-flight submissions survive a restart.
- Startup reconciles `SUBMITTED` records against the chain.
- Test simulates restart with an in-flight submission.

---

## Issue #12: Soft-deleted payments appear in `GET /api/payments` responses

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
The all-payments query does not filter `deletedAt`, so soft-deleted payments surface in listings and totals.

### Impact
Reports and dashboards double-count or show deleted payments; reconciliation totals are wrong.

### Proposed Fix
Add `deletedAt: null` to the base query (or a Mongoose query helper / global pre-hook) and audit all payment read paths for the same omission.

### Acceptance Criteria
- Soft-deleted payments excluded from all default reads and aggregates.
- A shared query helper enforces the filter.
- Test covers exclusion in list + report paths.

---

## Issue #13: No rate limiting / size cap on `POST /api/students/bulk`

**Labels:** `security`, `performance`, `backend`

### Problem
Bulk import has no dedicated rate limit or row/byte cap, enabling DoS via huge uploads that exhaust memory/CPU.

### Impact
A single large upload can degrade or crash the instance for all tenants.

### Proposed Fix
Add a strict per-tenant rate limit and a hard row/byte cap on the bulk endpoint, returning `413`/`429` with clear codes. Stream-parse rather than buffering the whole file.

### Acceptance Criteria
- Oversized uploads rejected with `413`.
- Excessive frequency rejected with `429`.
- Streaming parse avoids loading the whole file into memory.

---

## Issue #14: Fee cascade update sets `remainingBalance: null` instead of recalculating

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
`feeController.updateFeeStructure` with `cascadeToStudents: true` writes `remainingBalance: null` rather than recomputing `newFee − amountPaid` per student.

### Impact
Balances become null/incorrect for affected students; payment-status logic and reminders break.

### Proposed Fix
Recompute each student's `remainingBalance` from the new fee minus their confirmed payments, in a bulk operation, inside a transaction; record a `studentFeeHistory` entry.

### Acceptance Criteria
- Cascade recomputes `remainingBalance` correctly per student.
- Operation is atomic and audited via fee history.
- Test covers partial-payment students.

---

## Issue #15: Health check does not verify Stellar Horizon connectivity

**Labels:** `enhancement`, `observability`, `stellar-integration`

### Problem
`/health` (`healthController.js`) does not probe Horizon, so the service reports healthy while blockchain sync is fully broken.

### Impact
Orchestrators keep routing traffic to an instance that cannot process payments; outages are detected late.

### Proposed Fix
Add a bounded Horizon connectivity probe (and Redis/Mongo checks) to `/health`, with separate `ready` vs `live` semantics. Surface the failover client's active endpoint and circuit state.

### Acceptance Criteria
- `/health` reports Horizon reachability with a timeout.
- Liveness vs readiness separated.
- Failover endpoint + circuit state included.

---

## Issue #16: Audit log endpoint has no pagination

**Labels:** `bug`, `performance`, `backend`

### Problem
`GET /api/audit-logs` returns the full collection. With a TTL index but high write volume, the unbounded response exhausts memory and bandwidth.

### Impact
Large audit logs OOM the process or time out the request.

### Proposed Fix
Add cursor or page/limit pagination with sane caps, filterable by action/date/actor, using the compound index added in migration `016`.

### Acceptance Criteria
- Endpoint paginates with a max page size.
- Filters by action/date/actor.
- Uses the compound index (no COLLSCAN).

---

## Issue #17: `paymentModel` pre-save hook blocks legitimate admin status overrides

**Labels:** `bug`, `backend`

### Problem
The status-transition guard rejects transitions out of `SUCCESS`/`FAILED` (e.g. `SUCCESS → DISPUTED`), which an admin override legitimately needs.

### Impact
Admins cannot mark a confirmed payment disputed/refunded; dispute workflow is blocked at the model layer.

### Proposed Fix
Model an explicit state machine with allowed transitions including admin-authorized ones (`SUCCESS → DISPUTED`, `SUCCESS → REFUNDED`), gated by an override flag that is audited.

### Acceptance Criteria
- Allowed transitions defined declaratively.
- Admin override path permitted and audited.
- Invalid transitions still rejected with a clear error.

---

## Issue #18: `generateStudentId` has no collision retry loop

**Labels:** `bug`, `backend`

### Problem
`utils/generateStudentId.js` can collide with the unique index; the failure surfaces as an opaque `409` instead of retrying with a new candidate.

### Impact
Intermittent student-creation failures under concurrency; confusing client errors.

### Proposed Fix
Wrap generation in a bounded retry loop that regenerates on duplicate-key error and only surfaces an error after N attempts.

### Acceptance Criteria
- Retries up to N times on collision.
- Surfaces a clear error only after exhausting retries.
- Test forces a collision and asserts recovery.

---

## Issue #19: Frontend dashboard fetches all students without pagination

**Labels:** `performance`, `frontend`

### Problem
`frontend/src/pages/dashboard.jsx` fetches every student in one call and renders them all, freezing for schools with thousands of students.

### Impact
The dashboard becomes unusable for large tenants; high memory and slow first paint.

### Proposed Fix
Add server-side pagination + search, virtualized rendering, and incremental loading. Show counts from server aggregates rather than client-side array length.

### Acceptance Criteria
- Dashboard paginates/virtualizes student lists.
- Counts come from server aggregates.
- Smooth interaction with 10k students.

---

## Issue #20: No end-to-end test of the full payment flow

**Labels:** `testing`, `stellar-integration`

### Problem
There is no E2E test covering intent creation → on-chain submission (mocked Horizon) → polling → status update → webhook/SSE → receipt.

### Impact
Regressions in the core money path can ship undetected; each unit test covers only a slice.

### Proposed Fix
Add an E2E suite using `mongodb-memory-server` and a mocked Horizon that drives a payment from intent to confirmed, asserting side effects (webhook fired, SSE emitted, receipt created).

### Acceptance Criteria
- One test exercises the full happy path.
- Asserts webhook + SSE + receipt side effects.
- Runs in CI without real network calls.

---

## Issue #21: Missing/under-used compound index for report queries

**Labels:** `performance`, `backend`

### Problem
Report queries filter/sort by `schoolId + status + confirmedAt`. Migration `014_add_payment_report_index.js` exists; verify it matches the actual query shape and that `reportService` queries use it (no in-memory sort/COLLSCAN).

### Impact
Slow report generation and high DB load as payment volume grows.

### Proposed Fix
Confirm the index key order matches the query's equality→sort→range pattern; add `.explain()` assertions in tests; add covering projections where possible.

### Acceptance Criteria
- Report queries use an index (verified via `explain`).
- No in-memory sort on large result sets.
- Index key order matches query shape.

---

## Issue #22: `reportService.reportToCsv` does not escape commas/quotes/newlines

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
CSV generation concatenates field values without RFC-4180 escaping, so a school name or note containing `,`, `"`, or a newline corrupts the file and shifts columns. A leading `=`/`+`/`-`/`@` enables CSV injection in spreadsheet apps.

### Impact
Corrupt exports and a CSV-injection vector against finance staff opening the file.

### Proposed Fix
Use a vetted CSV serializer (or implement RFC-4180 quoting) and neutralize formula-injection prefixes.

### Acceptance Criteria
- Fields with delimiters/quotes/newlines are correctly quoted.
- Formula-injection prefixes are neutralized.
- Round-trip parse test passes.

---

## Issue #23: `POST /api/payments/verify` does not validate `txHash` presence/format

**Labels:** `bug`, `backend`

### Problem
The verify handler processes the request without first asserting `txHash` exists and matches the expected hex/length, leading to downstream Horizon calls with `undefined`.

### Impact
Confusing 500s and wasted Horizon calls; potential unhandled rejections.

### Proposed Fix
Validate `txHash` via the schema layer (`middleware/schemas/paymentSchemas.js` + `validate.js`) before the controller runs; reject malformed hashes with `400`.

### Acceptance Criteria
- Missing/malformed `txHash` returns `400` with a clear code.
- Controller never calls Horizon with an invalid hash.
- Schema test added.

---

## Issue #24: `schoolContext` middleware ignores mid-request school deactivation

**Labels:** `bug`, `security`, `multi-school`

### Problem
`middleware/schoolContext.js` resolves the school once; it does not re-check `isActive`/deactivation, so a deactivated school can still drive writes if the context was cached or the flag flips mid-flight.

### Impact
Deactivated/suspended tenants continue to transact; billing/compliance suspensions are not enforced.

### Proposed Fix
Reject requests for inactive schools with `403 SCHOOL_INACTIVE` at context resolution; ensure no stale cache bypasses the check.

### Acceptance Criteria
- Requests for inactive schools return `403`.
- No cached context bypasses the active check.
- Test toggles `isActive` and asserts rejection.

---

## Issue #25: `feeAdjustmentEngine` can produce negative fee amounts

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
`services/feeAdjustmentEngine.js` applies discount/surcharge rules without a floor, so stacked percentage/fixed discounts can drive the final fee below zero.

### Impact
Negative balances and "the school owes the parent" states; corrupted reconciliation.

### Proposed Fix
Clamp the computed fee at `0`, validate rule definitions at creation time, and reject/flag rule sets whose worst-case stack goes negative.

### Acceptance Criteria
- Final fee never goes below zero.
- Rules validated at creation.
- Test covers stacked discounts exceeding 100%.

---

## Issue #26: Authentication is a single shared admin credential — no per-school users or RBAC

**Labels:** `security`, `critical`, `feature`, `backend`

### Problem
`controllers/authController.js` authenticates against a single `ADMIN_USERNAME`/`ADMIN_PASSWORD` pair from the environment and issues a JWT with `role: 'admin'`. There is no concept of per-school operators, no user collection, and no role/permission model. Every school's data is reachable by the one global admin; there is no per-tenant login, no scoping of the admin token to a specific `schoolId`, and no way to grant a school's bursar access to only their data.

### Impact
- A genuine multi-tenant SaaS cannot onboard independent schools — they would all share one credential.
- No least-privilege: the single admin can read/write every tenant.
- Credential rotation means redeploying the whole service.
- No per-user audit attribution: every action logs as "admin".

### Proposed Fix
Introduce a `User` model (email, hashed password via bcrypt/argon2, `schoolId`, `roles[]`), a session/JWT carrying `userId + schoolId + roles`, and middleware that enforces both tenant scope (token `schoolId` must match `req.schoolId`) and role-based permissions. Keep the env super-admin only as a break-glass bootstrap account.

### Acceptance Criteria
- `User` model with hashed passwords and per-school association exists.
- JWT carries `userId`, `schoolId`, and `roles`.
- Tenant-scoped middleware rejects tokens whose `schoolId` ≠ requested tenant.
- At least `owner`, `staff`, `read-only` roles enforced on representative routes.
- Audit logs attribute actions to a specific user.

---

## Issue #27: Admin credentials are compared as plaintext from environment variables

**Labels:** `security`, `critical`, `backend`

### Problem
`handleLogin` compares the submitted password to `process.env.ADMIN_PASSWORD` directly (constant-time, but plaintext). The password lives unhashed in env/secrets, deploy manifests, and potentially CI logs.

### Impact
Anyone with access to the environment (ops, CI, a leaked `.env`) obtains the production admin password directly; there is no hash to slow an attacker who exfiltrates config.

### Proposed Fix
Store an `ADMIN_PASSWORD_HASH` (argon2id/bcrypt) instead of the plaintext, verify with the library's constant-time compare, and document a hash-generation script. Migrate `.env.example` accordingly.

### Acceptance Criteria
- Login verifies against a stored password **hash**.
- No plaintext password appears in env or code.
- `.env.example` and docs updated; helper script provided.

---

## Issue #28: No brute-force protection or account lockout on `POST /api/auth/login`

**Labels:** `security`, `backend`

### Problem
The login route relies only on the global IP rate limiter (`concurrentRequestHandler`, 100 req/min/IP). There is no per-account failed-attempt tracking, lockout, or exponential backoff, and the limiter is in-process (resets on restart, not shared across replicas without Redis).

### Impact
Distributed credential-guessing across IPs is not slowed; a single admin secret is a high-value brute-force target.

### Proposed Fix
Add a dedicated login limiter keyed by username with progressive delay/lockout backed by Redis, emit a metric/alert on repeated failures, and add a CAPTCHA/step-up hook after N failures.

### Acceptance Criteria
- Repeated failed logins trigger lockout/backoff.
- Counters shared across replicas via Redis.
- Failed-login spike emits a metric and alert.

---

## Issue #29: MFA dependency is present (`speakeasy`) but TOTP is not wired into login

**Labels:** `security`, `feature`, `backend`

### Problem
`speakeasy` is a dependency and suspicious-payment/MFA scaffolding exists, but admin login does not require a second factor. For a system that moves money, single-factor admin auth is insufficient.

### Impact
A leaked admin password fully compromises every tenant with no second barrier.

### Proposed Fix
Add TOTP enrollment + verification to the auth flow (secret stored encrypted, recovery codes hashed), require the second factor after password success, and gate sensitive admin actions on a fresh MFA assertion.

### Acceptance Criteria
- Admin can enroll TOTP; secret stored encrypted.
- Login requires the TOTP code when enrolled.
- Recovery codes generated and single-use.

---

## Issue #30: Refresh tokens are opaque but never rotated or bound to a session

**Labels:** `security`, `backend`

### Problem
`handleRefresh` validates a refresh token against the store and mints a new access token, but does **not** rotate the refresh token, bind it to a device/session, or detect reuse. A stolen refresh token is valid for its full 30-day TTL.

### Impact
A leaked refresh token grants 30 days of silent access; there is no reuse-detection to revoke a compromised token family.

### Proposed Fix
Implement refresh-token rotation (issue a new refresh token on each use, invalidate the old), reuse detection (replay of a rotated token revokes the whole family), and bind tokens to a session record with device metadata.

### Acceptance Criteria
- Each refresh rotates the token and invalidates the prior one.
- Replay of a consumed refresh token revokes the family.
- Sessions are listable/revocable by the admin.

---

## Issue #31: Login stores the refresh token "fire-and-forget" — token may be unusable

**Labels:** `bug`, `security`, `backend`

### Problem
In `handleLogin`, `getStore().set(refreshToken, refreshTTL).catch(() => {})` is not awaited. If the Redis write fails or lags, the client receives a refresh token the server never persisted, so the subsequent refresh fails confusingly.

### Impact
Intermittent "invalid refresh token" errors right after a successful login when the store write loses the race; silent loss of the failure.

### Proposed Fix
`await` the store write before returning the token; on failure, return `500` rather than handing out an unusable token. Log failures via `logger`.

### Acceptance Criteria
- Refresh token is persisted before the response is sent.
- Persistence failure returns an error instead of a dead token.
- Failure is logged structured.

---

## Issue #32: Access token delivered both as httpOnly cookie and JSON body — inconsistent and XSS-exposed

**Labels:** `security`, `backend`, `frontend`

### Problem
`handleLogin` sets an httpOnly `admin_token` cookie **and** returns `refreshToken` in the JSON body; `handleRefresh` returns the access `token` in the body (readable by JS). Mixing cookie and body delivery yields an inconsistent model: the cookie is XSS-safe but the body token is not, and CSRF protection for the cookie path is unclear.

### Impact
If the frontend stores the body token in `localStorage`, any XSS exfiltrates it; if it relies on the cookie, CSRF defenses are needed. The dual model invites mistakes.

### Proposed Fix
Pick one model: httpOnly cookie for the access token + CSRF token (double-submit) for state-changing requests, **or** body token with strict CSP and in-memory storage. Document the chosen contract and align the frontend.

### Acceptance Criteria
- A single, documented token-delivery model.
- CSRF protection if cookie-based.
- Frontend updated to match; no token in `localStorage` if cookie-based.

---

## Issue #33: `JWT_SECRET` is not validated at startup; weak/empty secret fails open

**Labels:** `security`, `backend`

### Problem
`jwt.sign(..., process.env.JWT_SECRET)` is used without asserting the secret exists and meets a minimum entropy/length at boot. An empty or short secret produces forgeable tokens.

### Impact
A missing/weak secret yields trivially forgeable admin tokens — full compromise — and the failure only surfaces at request time, not startup.

### Proposed Fix
Validate `JWT_SECRET` (and other required secrets) in `config/index.js` at startup: fail fast if absent or below a minimum length/entropy. Support key-ID-based rotation.

### Acceptance Criteria
- Startup aborts when `JWT_SECRET` is missing/too weak.
- Minimum length/entropy enforced and documented.
- Rotation strategy documented.

---

## Issue #34: `GET /api/auth/me` returns `{ isAdmin: true }` unconditionally

**Labels:** `bug`, `security`, `backend`

### Problem
`handleMe` always returns `{ isAdmin: true }`. If the route is not strictly guarded by `requireAdminAuth` (verify), the frontend may treat unauthenticated users as admins. Even when guarded, returning a static payload hides token expiry/role detail the frontend needs.

### Impact
Risk of a client-side auth bypass if the guard is ever loosened; the frontend can't distinguish roles or near-expiry sessions.

### Proposed Fix
Ensure `/api/auth/me` is behind `requireAdminAuth` and returns the verified principal (`userId`, `schoolId`, `roles`, `exp`). Add a test that an unauthenticated request returns `401`.

### Acceptance Criteria
- Unauthenticated `/me` returns `401`.
- Response reflects the actual verified principal.
- Test added.

---

## Issue #35: CORS `credentials: true` combined with header-driven tenant selection needs an origin allowlist audit

**Labels:** `security`, `backend`

### Problem
`app.js` enables `cors({ origin: allowedOrigins, credentials: true })` and accepts `X-School-ID` to select tenant. If `parseAllowedOrigins()` ever resolves to `*` or a permissive list, credentialed cross-origin requests could drive tenant-scoped actions from untrusted origins.

### Impact
A misconfigured origin list with credentials enabled is a CSRF/credential-leak vector across tenants.

### Proposed Fix
Assert at startup that the origin list is non-empty and never wildcard when `credentials` is true; add tests for `parseAllowedOrigins` covering empty/`*`/comma-list inputs; document required `CORS_ORIGINS`.

### Acceptance Criteria
- Wildcard origin + credentials rejected at startup.
- `parseAllowedOrigins` unit-tested for edge cases.
- Misconfiguration is loud, not silent.

---

## Issue #36: No security headers/`Cache-Control` on sensitive JSON responses

**Labels:** `security`, `backend`

### Problem
Helmet is configured for an API (CSP `default-src 'none'`), but responses carrying tokens, payment data, and audit logs do not set `Cache-Control: no-store`. Intermediaries/proxies may cache sensitive payloads.

### Impact
Tokens or financial data could be cached by a shared proxy/CDN and served to another user.

### Proposed Fix
Add `Cache-Control: no-store` (and `Pragma: no-cache`) to auth and sensitive data responses via middleware; verify Helmet covers `X-Content-Type-Options`, `Referrer-Policy`, etc.

### Acceptance Criteria
- Auth and sensitive responses set `no-store`.
- Security-header test asserts presence on representative routes.

---

## Issue #37: No request-size / depth limits beyond a global JSON limit (JSON-bomb / param pollution)

**Labels:** `security`, `backend`

### Problem
`express.json({ limit: config.MAX_BODY_SIZE })` caps body size, but there is no protection against deeply-nested JSON, array explosion, or HTTP parameter pollution on query strings used in filters/aggregation.

### Impact
Deeply-nested or polluted inputs can cause CPU spikes in validation/aggregation, or change query semantics (e.g. `?status=a&status=b` arriving as an array).

### Proposed Fix
Enforce max object depth/array length in the validation layer, normalize/whitelist query parameters, and reject duplicated scalar query params.

### Acceptance Criteria
- Over-deep/over-wide payloads rejected with `400`.
- Query params whitelisted and de-polluted.
- Tests cover nested-bomb and duplicate-param inputs.

---

## Issue #38: Secrets and PII may leak through logs and error responses

**Labels:** `security`, `observability`, `backend`

### Problem
`utils/redactConfig.js` exists, but there is no enforced redaction on `requestLogger`/`morgan` (which logs URLs/headers) or on error serialization. Authorization headers, `Idempotency-Key`, memos (student IDs), and emails can reach logs.

### Impact
PII and secrets in centralized logs create a compliance and credential-leak exposure.

### Proposed Fix
Add a redaction layer to the logger (drop `Authorization`, cookies, tokens; hash/mask student IDs and emails), ensure `morgan` does not log auth headers, and confirm `errorHandler` never echoes internals to clients in production.

### Acceptance Criteria
- Sensitive headers/fields are redacted in all logs.
- Error responses never include stack traces/internals in prod (see `errorHandlerStackTrace.test.js` — extend it).
- Redaction unit-tested.

---

## Issue #39: No dependency / supply-chain scanning in CI

**Labels:** `security`, `devops`, `tech-debt`

### Problem
There is no automated `npm audit`/SCA (Dependabot/Snyk) gate, and `package-lock.json` is large. Vulnerable transitive deps (axios, stellar-sdk, mongoose, bullmq) can persist unnoticed.

### Impact
Known CVEs ship to production; no alerting on newly-disclosed vulnerabilities.

### Proposed Fix
Add a CI job running `npm audit --audit-level=high` (failing the build) plus Dependabot/Renovate for automated PRs, and pin/verify lockfile integrity.

### Acceptance Criteria
- CI fails on high/critical advisories.
- Automated dependency-update PRs enabled.
- Documented process for triaging advisories.

---

## Issue #40: Metrics endpoint auth and exposure need hardening

**Labels:** `security`, `observability`, `backend`

### Problem
`/metrics` is mounted **before** the rate limiter (intentionally, so Prometheus is never throttled) and is guarded by `middleware/metricsAuth.js`. Verify the auth is strong (not a static guessable token), that the endpoint is network-restricted, and that metrics don't leak per-tenant identifiers enabling enumeration.

### Impact
An unauthenticated/weakly-authenticated metrics endpoint leaks tenant counts, volumes, and internal cardinality; being pre-rate-limiter, it's also a DoS surface.

### Proposed Fix
Require a strong bearer/mTLS for `/metrics`, restrict by network policy, and audit label cardinality so no high-cardinality tenant identifiers are exported as labels.

### Acceptance Criteria
- `/metrics` requires strong auth and/or network restriction.
- No unbounded/tenant-identifying labels.
- Abuse of the unthrottled path is bounded (e.g. separate limiter).

---

## Issue #41: Tenant selection trusts the `X-School-ID` header without binding to the authenticated principal

**Labels:** `security`, `critical`, `multi-school`

### Problem
The CORS config allows `X-School-ID`, and `schoolContext` resolves the tenant from it. With a single global admin token, any caller can set `X-School-ID` to any tenant. Tenant identity is not derived from (or checked against) the authenticated user.

### Impact
Horizontal privilege escalation across tenants by simply changing a header — the core multi-tenant isolation guarantee is unenforced at the identity layer.

### Proposed Fix
Once per-school users exist (Issue #26), bind the resolved tenant to the token's `schoolId` and reject mismatches. Until then, restrict `X-School-ID` overrides to the break-glass super-admin only and audit every override.

### Acceptance Criteria
- Tenant is derived from/checked against the principal.
- Header override allowed only for super-admin and audited.
- Cross-tenant header attempt returns `403`.

---

## Issue #42: No automated audit that every tenant-scoped query includes `schoolId`

**Labels:** `security`, `multi-school`, `testing`

### Problem
Isolation depends on every Mongoose query including `schoolId`. There is no lint rule, query-helper, or test sweeping all models/controllers to guarantee this invariant; it is enforced by convention only.

### Impact
A single missing `schoolId` filter in any current or future query silently leaks cross-tenant data.

### Proposed Fix
Introduce a tenant-aware query helper or Mongoose plugin that injects/asserts `schoolId`, and add a CI test enumerating read paths to assert tenant scoping (or an ESLint rule flagging raw `Model.find` in controllers).

### Acceptance Criteria
- A tenant-scoped query helper/plugin exists and is used.
- CI fails if a tenant-scoped model is queried without `schoolId`.
- Documented pattern for adding new tenant models.

---

## Issue #43: No per-tenant resource quotas or fair-use limits

**Labels:** `enhancement`, `multi-school`, `performance`

### Problem
Rate limiting is per-IP (`req.ip`), not per-tenant. One noisy school (huge syncs, bulk imports, report spam) can consume shared Horizon quota, DB, and queue capacity, degrading every other tenant.

### Impact
Noisy-neighbor effects: one tenant's load causes another's outage; no way to enforce plan limits.

### Proposed Fix
Add per-tenant quotas (requests/min, sync frequency, max students, report concurrency) backed by Redis counters, returning `429` with tenant-scoped headers, and expose usage in metrics.

### Acceptance Criteria
- Per-tenant limits enforced for sync/import/report.
- `429` responses are tenant-scoped.
- Per-tenant usage visible in metrics.

---

## Issue #44: No tenant data export / deletion (GDPR-style) workflow

**Labels:** `feature`, `compliance`, `multi-school`

### Problem
There is no endpoint/job to export or erase a single school's (or a single student's) data on request. Soft-delete exists for students but no cascade export/erasure across payments, receipts, disputes, audit logs.

### Impact
Cannot satisfy data-subject access/erasure requests or off-board a school cleanly; compliance risk.

### Proposed Fix
Add an admin "export tenant data" job (bundles students/payments/receipts/disputes) and an "erase/anonymize" workflow that respects financial-record retention (anonymize PII, keep immutable ledger refs).

### Acceptance Criteria
- Per-tenant and per-student export produced as a downloadable bundle.
- Erasure anonymizes PII while preserving required financial records.
- Both actions are audited.

---

## Issue #45: School `slug` uniqueness and immutability constraints under-tested

**Labels:** `bug`, `multi-school`, `data-integrity`

### Problem
Migration `008_add_school_slug_unique_index.js` adds a unique slug index, but there are no tests around slug collision handling, reserved slugs (e.g. `api`, `admin`, `health`), or whether a slug can be changed after creation (which would break existing payment instructions/links).

### Impact
Slug collisions surface as opaque `500`s; renaming a slug silently breaks shared payment links and bookmarks.

### Proposed Fix
Reserve system slugs, return a clear `409` on collision, and make slug changes either disallowed or accompanied by a redirect/alias table.

### Acceptance Criteria
- Reserved slugs rejected with a clear error.
- Collisions return `409`, not `500`.
- Slug-change policy implemented and tested.

---

## Issue #46: No per-tenant feature flags / configuration overrides

**Labels:** `enhancement`, `multi-school`

### Problem
`SystemConfig` holds global defaults (`maintenanceMode`, `maxSyncBatchSize`, `reminderEnabled`, `reminderIntervalMs`), but there is no per-school override layer. Schools cannot independently enable reminders, set sync batch sizes, or opt into beta features.

### Impact
All tenants are forced onto identical operational settings; rollout/canarying per tenant is impossible.

### Proposed Fix
Add a per-school config layer that overrides global `SystemConfig`, with a resolved-config accessor used everywhere settings are read.

### Acceptance Criteria
- Per-school overrides resolve over global defaults.
- A single accessor is the source of truth for settings.
- Reminder enable/interval works per tenant.

---

## Issue #47: Background schedulers run on every replica with no leader election for non-locked jobs

**Labels:** `bug`, `critical`, `multi-school`, `devops`

### Problem
`app.js` starts `startPolling`, `startConsistencyScheduler`, `startReminderScheduler`, `startReconciliationScheduler`, `startAuditLogCleanupScheduler`, etc. on **every** instance. Polling uses a distributed lock, but it's unclear all schedulers do. Without leader election, reminders/cleanup/reconciliation can run N× concurrently when scaled.

### Impact
Duplicate reminder emails, duplicate webhook fires, redundant Horizon load, and racey cleanup when running more than one replica.

### Proposed Fix
Route every periodic job through the existing `distributedLock` (or a single leader-election lease), and add tests asserting a job body executes once across simulated replicas.

### Acceptance Criteria
- Every scheduler acquires a distributed lock/lease before running.
- Two replicas produce one execution per tick.
- Per-job lock coverage documented.

---

## Issue #48: No tenant-level "maintenance mode" enforcement path verified

**Labels:** `enhancement`, `multi-school`, `backend`

### Problem
`SystemConfig.maintenanceMode` exists as a default but it's unclear any middleware reads it to actually reject traffic, and there's no per-tenant maintenance toggle.

### Impact
Operators can't safely take the system (or a single tenant) offline for migrations; writes continue during maintenance.

### Proposed Fix
Add middleware that, when global or per-tenant maintenance is on, returns `503` with `Retry-After` for mutating routes while allowing health/metrics. Surface state in `/health`.

### Acceptance Criteria
- Maintenance mode blocks writes with `503` + `Retry-After`.
- Per-tenant maintenance supported.
- Health endpoint reflects maintenance state.

---

## Issue #49: Horizon failover client lacks visibility and tunable circuit-breaker policy surfacing

**Labels:** `enhancement`, `observability`, `stellar-integration`

### Problem
`services/horizonFailoverClient.js` (circuit breaker, PR #775) handles endpoint failover, but the active endpoint, breaker state, and failover counts are not consistently exported as metrics or surfaced in `/health`. Thresholds may be hard-coded.

### Impact
Operators can't see when the system is running on a degraded/backup Horizon endpoint or why; tuning requires code changes.

### Proposed Fix
Export `horizon_active_endpoint`, `horizon_circuit_state`, and failover/retry counters; make thresholds configurable via env; include the state in `/health`.

### Acceptance Criteria
- Breaker state + active endpoint exported as metrics and in `/health`.
- Thresholds configurable via env.
- Failover event emits a structured log + metric.

---

## Issue #50: Horizon cursor management and pagination correctness for the poller is unverified

**Labels:** `bug`, `stellar-integration`, `data-integrity`

### Problem
`transactionPollingService.js` syncs payments by reading account operations/transactions from Horizon. It is unclear the poller persists and resumes from a per-account `paging_token` cursor, handles Horizon's `429`/reset, and avoids both gaps (missed txs) and unbounded re-scans (replaying from genesis each cycle).

### Impact
Either missed payments (cursor skips ahead) or excessive Horizon load and slow syncs (re-reading history every poll).

### Proposed Fix
Persist a per-school/account cursor, resume from it each cycle, handle `429` with backoff via the rate-limited client, and add tests for gap-free, resumable paging including a reset scenario.

### Acceptance Criteria
- Cursor persisted and resumed per account.
- No gaps and no full-history rescans across cycles.
- Tests cover resume + `429` handling.

---

## Issue #51: No reorg / failed-transaction handling distinct from successful ledger inclusion

**Labels:** `bug`, `stellar-integration`, `data-integrity`

### Problem
Stellar transactions can be included in a ledger but `result.successful = false` (e.g. failed operations), and Horizon can return transactions that later differ. The sync path should only credit payments where the operation actually succeeded and the asset/amount matches; it's unclear failed-but-included txs are filtered.

### Impact
A failed/partial transaction could be credited as a payment, or a malformed operation could be matched to a student.

### Proposed Fix
In `extractValidPayment`/parsers, assert `transaction.successful === true`, verify the operation type is `payment`/`path_payment`, and validate the asset issuer for USDC. Add fixtures for failed and wrong-asset transactions.

### Acceptance Criteria
- Only successful payment operations are credited.
- USDC asset issuer verified against config.
- Failed/wrong-asset fixtures asserted as rejected.

---

## Issue #52: USDC asset issuer / trustline validation not enforced

**Labels:** `security`, `critical`, `stellar-integration`

### Problem
The system "supports USDC", but parsing/crediting must verify the asset's **issuer** matches the canonical Circle USDC issuer for the active network. Without this, a fake token also named `USDC` from any issuer could be credited at face value.

### Impact
An attacker mints a worthless `USDC`-coded asset and "pays" fees with it; the system credits real fee balance — direct financial fraud.

### Proposed Fix
Pin the expected USDC issuer per network in `stellarConfig.js`, validate `asset_issuer` on every credited payment, and reject/flag mismatches as suspicious.

### Acceptance Criteria
- USDC payments validated against the pinned issuer.
- Non-canonical issuers rejected/flagged.
- Config differs correctly for testnet vs mainnet.

---

## Issue #53: Amount/precision handling for Stellar (7-decimal stroops) needs float-safety audit

**Labels:** `bug`, `data-integrity`, `stellar-integration`

### Problem
Stellar amounts have 7 decimal places and are exact integers in stroops. `amountExtractor.js` and fee comparisons appear to use JS floats (`parseFloat`, `toFixed`). Float arithmetic on monetary values risks off-by-epsilon mismatches between paid amount and required fee.

### Impact
A payment that exactly equals the fee may be judged short/over by a rounding epsilon, mis-flagging payments or rejecting valid ones.

### Proposed Fix
Represent amounts as integer stroops or use a decimal library for all comparisons; compare paid-vs-fee in stroops; centralize the conversion in one util.

### Acceptance Criteria
- Monetary comparisons use integer stroops / decimals, not floats.
- Exact-amount payments never mis-flagged by rounding.
- Property test over many amounts passes.

---

## Issue #54: Outgoing transaction submission lacks fee-bump / timebound / sequence-management strategy

**Labels:** `enhancement`, `stellar-integration`, `reliability`

### Problem
For any transactions the system itself submits (refunds, sweeps, account setup), `transactionManager.js` must handle base-fee surges (fee-bump transactions), `timebounds` to avoid stuck txs, and sequence-number contention. It's unclear these are implemented.

### Impact
Submissions stall during network fee spikes or sequence races, leaving operations stuck and retried incorrectly.

### Proposed Fix
Set conservative `timebounds`, support fee-bump on `tx_too_late`/fee surge, and serialize submissions per source account to avoid sequence collisions.

### Acceptance Criteria
- Submissions use timebounds and can be fee-bumped.
- Per-source-account sequence serialization.
- Tests cover fee surge and sequence contention.

---

## Issue #55: Secret key / signer management for school wallets is unspecified and risky

**Labels:** `security`, `critical`, `stellar-integration`, `compliance`

### Problem
The system references school wallet addresses; if it ever holds school **secret keys** (for sweeps/refunds), how those are encrypted, rotated, and access-controlled is undocumented. Plaintext secret keys in DB/env would be catastrophic.

### Impact
Compromise of stored secret keys means total loss of funds across schools.

### Proposed Fix
Document the custody model. Prefer non-custodial (schools sign their own) or, if custodial, store keys in a KMS/HSM, never in app DB/env, with per-key access audit and rotation. Add `compliance`/threat-model docs.

### Acceptance Criteria
- Custody model documented and threat-modeled.
- No plaintext secret keys in DB/env.
- KMS/HSM integration or non-custodial design enforced.

---

## Issue #56: Memo collision handling — multiple students cannot share a 28-byte memo namespace safely

**Labels:** `bug`, `stellar-integration`, `multi-school`

### Problem
The plaintext student ID is the on-chain memo and the sole matching key. Across schools sharing one collecting wallet (or if a parent fat-fingers a memo), the 28-byte memo is ambiguous and the wrong student could be credited. There's no per-school memo namespacing or checksum.

### Impact
Cross-student/cross-school mis-credit when memos collide or are mistyped; no detection of an invalid memo.

### Proposed Fix
Define a structured memo format (e.g. short school prefix + student code + check digit) within 28 bytes, validate the checksum on match, and route unmatched/ambiguous memos to a manual-review queue instead of silently dropping.

### Acceptance Criteria
- Memo format includes a tenant discriminator and check digit within 28 bytes.
- Invalid-checksum memos go to manual review, not silent drop.
- Tests cover collision and typo scenarios.

---

## Issue #57: Overpayment / underpayment / partial-payment policy is undefined

**Labels:** `bug`, `feature`, `data-integrity`

### Problem
When a parent pays more or less than the required fee, the handling is unclear: is an overpayment credited, refunded, or held? Is an underpayment a partial credit toward `remainingBalance` or rejected? `paymentLimits.js` exists but the end-to-end policy isn't documented or consistently enforced.

### Impact
Inconsistent crediting, surprised parents, and reconciliation drift; disputes increase.

### Proposed Fix
Define and implement explicit policies: partial payments decrement `remainingBalance`; overpayments create a credit balance or a refund task; both emit clear receipts and webhooks. Document the matrix.

### Acceptance Criteria
- Partial payments correctly reduce remaining balance.
- Overpayments handled per a documented policy.
- Receipts/webhooks reflect the exact applied amount.

---

## Issue #58: No idempotent guarantee that one on-chain tx credits at most one payment record

**Labels:** `bug`, `critical`, `data-integrity`, `stellar-integration`

### Problem
The poller, manual `verify`, and manual `sync` can all process the same transaction hash. Without a unique constraint on `(schoolId, transactionHash)` and an upsert-on-hash strategy, concurrent paths can create duplicate payment records for one ledger transaction.

### Impact
A single blockchain payment is counted multiple times, inflating revenue and over-crediting a student.

### Proposed Fix
Add a unique index on `transactionHash` (globally or per school), make crediting an idempotent upsert keyed on the hash, and handle the duplicate-key race gracefully.

### Acceptance Criteria
- Unique index prevents duplicate payments per tx hash.
- Concurrent poll + verify of the same tx yields one record.
- Race test passes.

---

## Issue #59: Payment intent expiry (`paymentIntentModel`) vs late on-chain payment is not reconciled

**Labels:** `bug`, `data-integrity`

### Problem
`paymentIntentModel` has a TTL (migrations `006`, `015`). If a parent pays after the intent expires (slow wallet, network delay), the on-chain payment still arrives but the intent is gone. It's unclear the poller still credits the student from the memo independent of the (expired) intent.

### Impact
Late-but-valid payments could be dropped or unmatched because the intent TTL'd away, costing parents money.

### Proposed Fix
Decouple crediting from intent existence: always credit a valid memo-matched on-chain payment; treat the intent as a UX convenience, not a prerequisite. Reconcile expired intents that later receive funds.

### Acceptance Criteria
- Valid on-chain payments credit even after intent expiry.
- Expired intents with funds are reconciled, not lost.
- Test covers pay-after-expiry.

---

## Issue #60: `pendingVerificationModel` retry path lacks a dead-letter and operator visibility

**Labels:** `enhancement`, `reliability`, `observability`

### Problem
`pendingVerificationModel` + migration `009_add_pending_verification_retry_indexes.js` imply a retry loop for verifications that aren't yet confirmable. There appears to be no terminal dead-letter state surfaced to operators when verification permanently fails, nor a metric for the backlog depth.

### Impact
Stuck verifications accumulate silently; operators can't see or act on a growing backlog.

### Proposed Fix
Add a terminal `dead_letter` state after max attempts, an admin endpoint to list/inspect/retry dead-lettered verifications, and a `pending_verification_backlog` metric/alert.

### Acceptance Criteria
- Exhausted verifications move to a visible dead-letter state.
- Admin can list and re-drive them.
- Backlog depth exported and alertable.

---

## Issue #61: Idempotency middleware key derivation and storage edge cases

**Labels:** `bug`, `reliability`, `backend`

### Problem
`middleware/idempotency.js` + `services/idempotencyStore.js` + `utils/idempotencyKey.js` implement an `Idempotency-Key` flow (recently consolidated, commit `5c20d68`). Edge cases need verification: same key + different request body, in-flight concurrent duplicates (should `409`/wait, not double-execute), and key TTL vs a retried client.

### Impact
A mis-handled idempotency key can either double-process a payment action or incorrectly replay a cached response for a different request.

### Proposed Fix
Hash the request body into the stored key fingerprint; reject same-key/different-body with `422`; for concurrent in-flight duplicates, return `409` or block on the first; document TTL semantics.

### Acceptance Criteria
- Same key + different body returns `422`.
- Concurrent duplicates don't double-execute.
- TTL and replay semantics documented and tested.

---

## Issue #62: Concurrent payment processor batch size / backpressure tuning and failure isolation

**Labels:** `performance`, `reliability`, `backend`

### Problem
`services/concurrentPaymentProcessor.js` (628 lines) processes payments concurrently. Concurrency limits, per-item failure isolation (one bad tx shouldn't fail the batch), and backpressure against Horizon/Mongo need review and tests.

### Impact
Under load, an unbounded concurrency can exhaust connections or trip the Horizon rate limiter; a single failure could abort a whole batch.

### Proposed Fix
Bound concurrency (e.g. `p-limit`), isolate per-item failures with structured results, apply backpressure when the Horizon rate-limited client signals saturation, and emit batch metrics.

### Acceptance Criteria
- Concurrency is explicitly bounded and configurable.
- One failed item doesn't fail the batch.
- Batch outcomes exported as metrics.

---

## Issue #63: Suspicious-payment multiplier / fraud-flagging rules are static and untunable per tenant

**Labels:** `enhancement`, `security`, `data-integrity`

### Problem
`SUSPICIOUS_PAYMENT_MULTIPLIER.md` and `detectAbnormalPatternsMultiplier.test.js` show a fraud heuristic, but thresholds appear global/static. Different schools have different normal ranges; a flat multiplier yields false positives/negatives.

### Impact
Legitimate large payments are flagged (parent friction) or fraudulent ones slip through, depending on the single global threshold.

### Proposed Fix
Make thresholds per-tenant configurable, base them on the tenant's historical distribution, and add a review/clear workflow with audit. Emit a `suspicious_payment_flagged` metric.

### Acceptance Criteria
- Thresholds configurable per tenant.
- Flags reviewable/clearable with audit.
- Metric exported for flagged volume.

---

## Issue #64: No refund workflow for disputed/erroneous payments

**Labels:** `feature`, `stellar-integration`, `compliance`

### Problem
Payments can be flagged suspicious or disputed, but there is no refund mechanism (build/sign/submit a return transaction, track its status, link it to the original payment and dispute).

### Impact
Schools have no in-system way to return funds for an erroneous/disputed payment; refunds happen off-system with no audit trail.

### Proposed Fix
Add a refund entity linking original payment ↔ refund tx, an admin-initiated refund flow (subject to custody model, Issue #55), status tracking, receipts, and webhook `payment.refunded`.

### Acceptance Criteria
- Admin can initiate a tracked refund tied to the original payment.
- Refund status reconciles against the chain.
- `payment.refunded` webhook + receipt emitted.

---

## Issue #65: Receipt generation lacks tamper-evidence and a verifiable public link

**Labels:** `enhancement`, `feature`, `compliance`

### Problem
`receiptService.js`/`receiptModel.js` produce receipts, but it's unclear they include a verifiable hash/signature and a public verification URL tying the receipt to the on-chain tx. A receipt's whole value proposition is verifiability.

### Impact
Receipts can't be independently verified as authentic; the "instant proof of payment" promise is weakened.

### Proposed Fix
Include the tx hash, a server signature over the receipt contents, and a public `GET /verify/:receiptId` page that recomputes/validates against the chain.

### Acceptance Criteria
- Receipts carry a verifiable signature + tx hash.
- A public verification endpoint validates authenticity.
- Tampered receipts fail verification.

---

## Issue #66: Payment status SSE/webhook side effects are not transactional with the DB write

**Labels:** `bug`, `reliability`, `data-integrity`

### Problem
On payment confirmation, the system writes the DB record and fires SSE + webhooks (`paymentSavedSubscribers.js`, `paymentEvents.js`). If the process crashes between the DB commit and the side effects (or vice versa), clients/webhooks and the DB diverge with no outbox to reconcile.

### Impact
A confirmed payment may never notify the school's webhook, or a webhook may fire for a write that later rolls back.

### Proposed Fix
Adopt a transactional outbox: write side-effect intents in the same DB transaction as the payment, then a dispatcher emits them at-least-once with dedup. This also fixes multi-replica duplicate emits.

### Acceptance Criteria
- Side effects recorded atomically with the payment write.
- A dispatcher guarantees at-least-once delivery with dedup.
- Crash between write and emit is recovered.

---

## Issue #67: No reconciliation report comparing on-chain totals to DB-recorded totals

**Labels:** `feature`, `data-integrity`, `observability`

### Problem
`reconciliationService.js`/`consistencyService.js` exist, but there's no periodic, surfaced report that sums credited payments in the DB and compares them to the school wallet's on-chain received total, flagging drift.

### Impact
Silent drift between ledger truth and DB accumulates; missed/duplicate credits go unnoticed until an audit.

### Proposed Fix
Add a scheduled reconciliation that compares per-school on-chain inflows to DB-credited totals within a tolerance, writes a report, and alerts on drift beyond threshold.

### Acceptance Criteria
- Periodic on-chain-vs-DB reconciliation per school.
- Drift beyond tolerance raises an alert.
- Report retrievable by admins.

---

## Issue #68: `payment.amount` and asset fields lack strict schema validation/normalization

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
Payment records carry `amount`, `assetCode`, `finalFee`, etc. Without strict schema validation (non-negative, finite, asset in an allowlist, consistent precision), malformed values from parsers can persist.

### Impact
Reports and balances inherit malformed numbers; `NaN`/negative amounts corrupt aggregates.

### Proposed Fix
Add Mongoose validators (min 0, finite, `assetCode` enum `['XLM','USDC']`) and normalize precision on save; add tests for boundary inputs.

### Acceptance Criteria
- Invalid amounts/assets rejected at the model layer.
- Precision normalized consistently.
- Aggregates never see `NaN`/negatives.

---

## Issue #69: Manual `verify` and `sync` endpoints lack idempotency + concurrency guards parity

**Labels:** `bug`, `reliability`, `backend`

### Problem
`syncAllPayments` uses an in-memory `_syncLocks` set (per-process), but `verify` may have no equivalent guard, and the in-memory lock doesn't work across replicas. Two replicas can sync the same school concurrently.

### Impact
Concurrent syncs across replicas double Horizon load and risk duplicate processing despite the per-process lock.

### Proposed Fix
Replace `_syncLocks` with the distributed lock keyed by `schoolId`, apply the same guard to `verify`, and return `409 SYNC_IN_PROGRESS` consistently.

### Acceptance Criteria
- Sync/verify guarded by a cross-replica distributed lock.
- Concurrent calls return `409`.
- Test simulates two replicas.

---

## Issue #70: No pagination/streaming on `GET /api/payments` (all payments)

**Labels:** `performance`, `backend`

### Problem
The all-payments listing (`paymentQueryController.js`) should enforce pagination and bounded page sizes; large tenants returning all payments in one response is a memory and latency risk (mirrors Issue #16 for audit logs).

### Impact
Large result sets OOM/slow the API and the frontend.

### Proposed Fix
Enforce cursor/page pagination with a max page size and sensible default sort backed by the report index; stream CSV exports.

### Acceptance Criteria
- Listing is paginated with a max page size.
- Default sort is index-backed.
- CSV export streams rather than buffering.

---

## Issue #71: Payment query filters allow unbounded/unsafe date ranges and regex

**Labels:** `security`, `performance`, `backend`

### Problem
If payment/report queries accept client `from`/`to` dates or free-text search that becomes a Mongo `$regex`, an attacker can request enormous ranges or a catastrophic-backtracking regex (ReDoS) against the DB.

### Impact
DoS via expensive queries; potential ReDoS on unindexed regex search.

### Proposed Fix
Cap date ranges (e.g. max 1 year), reject malformed dates, and replace free-text `$regex` with anchored/escaped patterns or a text index; validate all filter inputs.

### Acceptance Criteria
- Date ranges capped and validated.
- No unescaped user-driven `$regex`.
- Tests cover oversized-range and regex-injection inputs.

---

## Issue #72: Status enums and lifecycle are duplicated across model, controllers, and frontend

**Labels:** `tech-debt`, `backend`, `frontend`

### Problem
Payment statuses (`PENDING`, `SUBMITTED`, `SUCCESS`, `FAILED`, `DISPUTED`, etc.) appear as string literals in multiple places. Drift between the model's allowed set, controller checks, and frontend display causes subtle bugs.

### Impact
A status added in one place but not others breaks transitions/UX; magic strings invite typos.

### Proposed Fix
Define a single shared status enum + transition map (exported module) consumed by model validation, controllers, and (via the API contract) the frontend.

### Acceptance Criteria
- One canonical status/transition definition.
- Model + controllers import it; no inline literals.
- Frontend renders from the shared contract.

---

## Issue #73: Webhook retry uses fixed backoff with no jitter and only 3 attempts

**Labels:** `enhancement`, `reliability`, `backend`

### Problem
`webhookService.getBackoffDelay` uses fixed delays `[1m, 5m, 15m]` capped at `maxAttempts: 3` with **no jitter**. Many failing webhooks created in the same window retry in synchronized waves (thundering herd), and 3 attempts over ~21 minutes is short for a receiver outage.

### Impact
Synchronized retry storms against a recovering receiver; legitimate deliveries permanently fail after a brief 21-minute outage and land in `failed` with no auto-recovery.

### Proposed Fix
Add full jitter to backoff, make attempts/schedule configurable, and extend the schedule (e.g. up to hours) with a manual replay endpoint for `failed` deliveries.

### Acceptance Criteria
- Backoff includes jitter; schedule/attempts configurable.
- Receiver outages longer than 21 min are survivable.
- Admin can replay `failed` deliveries.

---

## Issue #74: `processPendingRetries` has no locking — duplicate webhook delivery across replicas

**Labels:** `bug`, `reliability`, `multi-school`

### Problem
`processPendingRetries` does `WebhookRetry.find({status:'pending', nextRetryAt:{$lte:now}}).limit(10)` then sends each. With multiple replicas (or overlapping ticks), two workers select the **same** rows and deliver the webhook twice. There is no atomic claim (`findOneAndUpdate` to an in-progress state) before sending.

### Impact
Receivers get duplicate `payment.confirmed` deliveries, causing double-processing downstream — exactly what `Delivery-ID` was meant to prevent but receivers may not dedupe.

### Proposed Fix
Atomically claim each retry (`findOneAndUpdate(status: pending → processing` with a lease/owner) before sending; only the claimer delivers. Reset stuck `processing` leases after a timeout.

### Acceptance Criteria
- Each pending retry is claimed atomically before send.
- Two replicas never deliver the same retry.
- Stuck `processing` leases auto-recover.

---

## Issue #75: Per-school webhook secret is stored in plaintext in `WebhookRetry`

**Labels:** `security`, `backend`

### Problem
`queueWebhookRetry` persists `secret: secret || null` directly on the `WebhookRetry` document. The HMAC signing secret sits in plaintext in MongoDB and in any backup/log of that collection.

### Impact
A DB read (or backup leak) exposes the signing secret, letting an attacker forge valid webhook signatures to the school's receiver.

### Proposed Fix
Don't store the secret on the retry doc; look it up from the (encrypted) school config at send time using `schoolId`, or store an encrypted reference. Encrypt secrets at rest (migration `015_add_school_webhook_secret.js` should use encryption).

### Acceptance Criteria
- Webhook secrets are not stored plaintext on retry docs.
- Secrets are encrypted at rest and resolved at send time.
- Migration re-encrypts any existing plaintext secrets.

---

## Issue #76: `fireWebhook` has no per-event subscription model or delivery history API

**Labels:** `feature`, `backend`

### Problem
Schools cannot subscribe to specific event types, register multiple endpoints, or view delivery history/status. The webhook URL/secret appear to be single per school, and there's no admin view of recent deliveries.

### Impact
Inflexible integrations; operators can't debug why a school's webhook isn't firing or filter to the events they care about.

### Proposed Fix
Add a `WebhookEndpoint` model (url, secret, subscribed events, active flag) supporting multiple endpoints, and a delivery-log API for inspection/replay.

### Acceptance Criteria
- Multiple endpoints + per-event subscriptions per school.
- Delivery history queryable and replayable.
- Disabled endpoints skipped.

---

## Issue #77: SSRF allowlist for webhook URLs needs DNS-rebinding and redirect hardening

**Labels:** `security`, `backend`

### Problem
`utils/validateWebhookUrl.js` validates URLs before delivery (good), but SSRF defenses commonly miss: re-validation after DNS resolution at request time (DNS rebinding), blocking redirects to internal addresses, and IPv6/loopback/link-local coverage. Axios follows redirects by default.

### Impact
A webhook URL that passes validation can resolve to or redirect into internal infrastructure (metadata endpoints, internal services).

### Proposed Fix
Resolve and pin the IP, reject private/loopback/link-local/metadata ranges (IPv4+IPv6), disable redirect following (or re-validate each hop), and bound response size.

### Acceptance Criteria
- DNS-resolved IP checked against deny ranges at send time.
- Redirects disabled or re-validated.
- IPv6/metadata ranges covered; tests added.

---

## Issue #78: Webhook payload includes raw student IDs / PII with no field-level controls

**Labels:** `security`, `compliance`, `backend`

### Problem
`notifyPaymentConfirmed` sends `studentId`, `senderAddress`, amounts, etc. to external URLs. There's no option to minimize PII per school, and the sender Stellar address is shared without consent controls.

### Impact
PII flows to third-party systems by default; compliance exposure and over-sharing of payer data.

### Proposed Fix
Make webhook payloads field-configurable per school (minimal by default), document the data shared, and allow opting out of PII fields.

### Acceptance Criteria
- Per-school control over which fields are sent.
- Minimal-PII default documented.
- Tests assert opt-out removes fields.

---

## Issue #79: No metric/alert on webhook failure rate or dead-letter growth

**Labels:** `observability`, `backend`

### Problem
Webhook failures are logged but not exported as metrics. There's no `webhook_delivery_failures_total`, `webhook_dead_letter_total`, or latency histogram, so a school whose endpoint is down goes unnoticed.

### Impact
Silent integration failures; operators learn of webhook outages only when a school complains.

### Proposed Fix
Export delivery success/failure counters, latency histograms, and dead-letter gauge via `prom-client`; alert on failure-rate spikes.

### Acceptance Criteria
- Delivery metrics exported by event and outcome.
- Dead-letter count alertable.
- Dashboard panel documented.

---

## Issue #80: `notificationService` / `emailService` lack provider abstraction, retries, and bounce handling

**Labels:** `enhancement`, `reliability`, `backend`

### Problem
`emailService.js` (67 lines) likely talks to one provider with no retry/queue, no bounce/complaint handling, and no templating separation. Reminder/receipt emails that transiently fail are simply lost.

### Impact
Dropped reminder/receipt emails; no visibility into bounces; hard to switch providers.

### Proposed Fix
Introduce a provider interface (SMTP/SES/SendGrid), queue email sends with retry, handle bounces/complaints (suppression list feeding Issue #9 opt-out), and externalize templates.

### Acceptance Criteria
- Pluggable email provider with retry/queue.
- Bounce/complaint suppression honored.
- Templates externalized and tested.

---

## Issue #81: Dual retry backends (BullMQ vs MongoDB) create divergent behavior and test gaps

**Labels:** `tech-debt`, `reliability`, `backend`

### Problem
`services/retryServiceSelector.js` chooses between `bullMQRetryService.js` and a MongoDB-backed `retryService.js` based on `REDIS_HOST`. The two backends have different durability, rate-limit, and concurrency semantics (`app.js` even warns the Mongo path's rate-limit counters are in-process only). Behavior differs between dev (Mongo) and prod (Redis), and tests likely cover only one.

### Impact
Bugs reproduce in prod but not dev (or vice versa); the less-used backend bit-rots; operators can't reason about retry guarantees uniformly.

### Proposed Fix
Define a single retry contract (interface + shared test suite run against both backends), document the guarantee differences, and make Redis the default for any multi-replica deployment with a startup warning otherwise.

### Acceptance Criteria
- One shared contract test runs against both backends.
- Documented guarantee matrix (durability, ordering, rate-limit scope).
- Startup warns loudly when using the in-process backend with >1 replica.

---

## Issue #82: BullMQ worker concurrency, failure handling, and dead-letter strategy unverified

**Labels:** `reliability`, `backend`, `observability`

### Problem
`bullMQRetryService.js` (462 lines) and `config/retryQueueSetup.js` wire BullMQ. Concurrency, `attempts`/backoff, removeOnComplete/Fail retention, stalled-job recovery, and a dead-letter queue for permanently-failed jobs need explicit configuration and tests.

### Impact
Misconfigured workers either retry forever (resource leak) or drop jobs silently; stalled jobs may never recover.

### Proposed Fix
Explicitly set worker concurrency, `attempts` with exponential backoff + jitter, retention limits, stalled-job handling, and a dedicated failed/dead-letter queue surfaced to admins. Add metrics (`queue/transactionRetryQueue.js`).

### Acceptance Criteria
- Worker options explicitly configured and documented.
- Permanently-failed jobs land in an inspectable dead-letter queue.
- Queue depth/failure metrics exported.

---

## Issue #83: Redis is a single point of failure for queue, SSE, rate-limit, refresh tokens, and locks

**Labels:** `reliability`, `critical`, `devops`

### Problem
When `REDIS_HOST` is set, Redis backs BullMQ, SSE pub/sub, rate limiting, refresh-token store, and distributed locks. A Redis outage degrades or breaks all of these simultaneously, and several clients use `enableOfflineQueue: false` / `maxRetriesPerRequest: null` with varying reconnect behavior.

### Impact
A single Redis blip can stall payments retries, break real-time updates, drop locks (double-processing), and invalidate sessions — a wide blast radius.

### Proposed Fix
Document the Redis dependency surface, define graceful-degradation per consumer (e.g. locks fail closed, SSE falls back to local), add health checks and reconnection/backoff policy, and consider Redis HA (Sentinel/Cluster) for production.

### Acceptance Criteria
- Each Redis consumer has a defined degradation mode.
- `/health` reports Redis status.
- Reconnection policy consistent and tested; HA documented.

---

## Issue #84: Distributed lock lacks fencing tokens / TTL-expiry safety

**Labels:** `bug`, `reliability`, `data-integrity`

### Problem
`services/distributedLock.js` provides locks for polling/schedulers. Classic single-Redis locks are unsafe under process pauses (GC/STW): a holder can believe it still owns a lock whose TTL expired and another worker acquired it, with no fencing token to reject the stale writer.

### Impact
Two workers can simultaneously run a "single-leader" job (duplicate reminders, double-credit) despite the lock, after a long GC pause.

### Proposed Fix
Add fencing tokens (monotonic) checked by the protected resource, keep critical sections short relative to TTL, and renew leases (watchdog). Document the safety guarantees and limits.

### Acceptance Criteria
- Locks issue a fencing token usable to reject stale holders.
- Lease renewal/watchdog for long jobs.
- Test simulates a paused holder + competing acquirer.

---

## Issue #85: Graceful shutdown doesn't drain in-flight queue jobs or SSE clients deterministically

**Labels:** `reliability`, `devops`, `backend`

### Problem
`shutdown()` stops schedulers and closes queues, but it's unclear BullMQ workers finish or re-queue in-flight jobs before exit, or that SSE clients receive a close event. The hard `SHUTDOWN_TIMEOUT_MS` force-exit can interrupt a payment mid-write.

### Impact
A deploy/rollover can interrupt in-flight payment processing or leave jobs in an ambiguous state; clients hang until their own timeout.

### Proposed Fix
Drain workers (let active jobs finish or re-queue), send SSE `close`/`retry` to clients, stop accepting new work first, and only force-exit after a bounded drain. Add a readiness flag flipped at shutdown start so LBs stop routing.

### Acceptance Criteria
- In-flight jobs finish or are safely re-queued on shutdown.
- SSE clients are told to reconnect.
- Readiness flips before drain; tested.

---

## Issue #86: No global unhandled-rejection / uncaught-exception safety net beyond process default

**Labels:** `reliability`, `backend`, `observability`

### Problem
`app.js` registers `SIGTERM`/`SIGINT` handlers but no `process.on('unhandledRejection')` / `uncaughtException` handler. Fire-and-forget promises (e.g. the login store write, several `.catch(()=>{})`) can crash or silently swallow.

### Impact
An unhandled rejection can crash the process without structured logging, or a swallowed one hides real failures.

### Proposed Fix
Add top-level handlers that log structured context and decide crash-vs-continue deliberately; audit `.catch(()=>{})` sites to log instead of swallow.

### Acceptance Criteria
- `unhandledRejection`/`uncaughtException` handlers log and exit/continue deliberately.
- Silent `.catch(()=>{})` sites log the error.
- Documented crash policy.

---

## Issue #87: Mongoose connection pool / write-concern / read-preference not tuned for production

**Labels:** `performance`, `reliability`, `backend`

### Problem
`mongoose.connect(config.MONGO_URI)` uses defaults: no explicit `maxPoolSize`, `serverSelectionTimeoutMS`, `socketTimeoutMS`, write concern (`w: 'majority'`), or read preference. Financial writes should use `majority` write concern; pool sizing affects throughput under load.

### Impact
Default pool may bottleneck or exhaust under concurrency; default write concern risks acknowledging a write the cluster could lose on failover.

### Proposed Fix
Set explicit pool size, timeouts, `w: 'majority'` for payment writes, and appropriate read preference; document the rationale and load-test.

### Acceptance Criteria
- Connection options explicitly set and documented.
- Payment writes use `majority` write concern.
- Load test validates pool sizing.

---

## Issue #88: Multi-document operations (payment + balance + history) are not transactional

**Labels:** `bug`, `critical`, `data-integrity`

### Problem
Crediting a payment touches multiple documents (payment, student `remainingBalance`, fee history, receipt). Without MongoDB multi-document transactions, a crash between writes leaves balances inconsistent with payments.

### Impact
A student's `remainingBalance` can diverge from their actual payments after a partial-failure, corrupting reminders and reports.

### Proposed Fix
Wrap related writes in a `session.withTransaction(...)` (requires a replica set), or adopt the outbox/idempotent-reapply pattern so re-running converges. Add a consistency test that injects a mid-sequence failure.

### Acceptance Criteria
- Related writes commit atomically (or converge on replay).
- Injected mid-write failure leaves a consistent state.
- `consistencyService` detects/repairs any residual drift.

---

## Issue #89: No backpressure between the poller and downstream processing

**Labels:** `performance`, `reliability`

### Problem
`transactionPollingService` reads batches and hands them to `concurrentPaymentProcessor`. If processing lags (slow Mongo/Horizon), the poller may keep enqueuing, growing memory. There's no queue-depth-based backpressure or adaptive batch sizing (`maxSyncBatchSize` is static).

### Impact
Under a burst (e.g. start-of-term payment spike), unbounded intake causes memory growth and latency.

### Proposed Fix
Make batch size adaptive to downstream queue depth/lag, pause polling when the processing queue exceeds a high-water mark, and resume below a low-water mark.

### Acceptance Criteria
- Polling pauses/resumes on queue-depth thresholds.
- Batch size adapts to load.
- Memory stays bounded under burst load (tested).

---

## Issue #90: `stuckPaymentReconciliation` runs once at startup but has no periodic schedule or bounds

**Labels:** `reliability`, `backend`

### Problem
`app.js` calls `reconcileStuckPayments()` once on boot. Payments can become stuck during normal runtime (Horizon blip, crash), but reconciliation only re-runs on the next restart. It also may be unbounded (scanning all `SUBMITTED`/`PENDING` regardless of age).

### Impact
Payments stuck after startup linger until the next deploy; a large stuck backlog could be scanned without limits.

### Proposed Fix
Schedule periodic reconciliation (leader-locked), bound it by age/limit, and emit a `stuck_payments` gauge with alerting.

### Acceptance Criteria
- Reconciliation runs periodically, not only at startup.
- Bounded by age/limit and leader-locked.
- Stuck-count metric exported and alertable.

---

## Issue #91: Reports are computed synchronously in-request with no caching or async generation

**Labels:** `performance`, `backend`

### Problem
`reportService.js` (342 lines) appears to aggregate on demand within the HTTP request. Large date ranges over high-volume tenants block the event loop / hold a connection, and identical reports are recomputed every call.

### Impact
Slow report endpoints under load; repeated heavy aggregations; potential request timeouts for big tenants.

### Proposed Fix
Cache report results (keyed by tenant+params+data-version) with short TTL, and move heavy/scheduled reports to async jobs with a downloadable artifact and status polling.

### Acceptance Criteria
- Repeated identical reports served from cache.
- Heavy reports generated async with status + download.
- No event-loop stalls on large aggregations.

---

## Issue #92: No materialized daily/monthly aggregates — every dashboard hit re-scans payments

**Labels:** `performance`, `data-integrity`

### Problem
Dashboard metrics and trend charts likely re-aggregate the raw `payments` collection on each request. As volume grows this is O(payments) per view.

### Impact
Dashboard latency grows linearly with payment history; DB load spikes with concurrent viewers.

### Proposed Fix
Maintain rolled-up `DailyMetrics`/`MonthlyMetrics` per school (updated incrementally on payment confirmation or via a scheduled rollup), and serve dashboards from the rollups with the raw collection as the source of truth for reconciliation.

### Acceptance Criteria
- Dashboards read from pre-aggregated rollups.
- Rollups updated incrementally and reconciled.
- Dashboard latency independent of total history size.

---

## Issue #93: Report exports have no row cap, timeout, or streaming for very large tenants

**Labels:** `performance`, `backend`

### Problem
CSV/report export (`reportController.js`, `ReportDownload.jsx`) can attempt to materialize an unbounded result set in memory.

### Impact
A multi-year export for a large school OOMs the process or times out.

### Proposed Fix
Stream exports using a Mongo cursor → CSV stream → HTTP response, enforce a max range, and offer async generation with email/download link for huge exports.

### Acceptance Criteria
- Exports stream rather than buffer.
- Max range enforced; oversized requests go async.
- Memory stays bounded during export (tested).

---

## Issue #94: Reports lack currency-at-time-of-payment vs current-rate distinction

**Labels:** `bug`, `data-integrity`, `feature`

### Problem
Financial reports convert XLM/USDC to local currency. If they use the *current* exchange rate rather than the rate at payment time, historical totals shift every day as the rate moves, making reports non-reproducible.

### Impact
A report run today shows different fiat totals than the same report run yesterday for the same period — unacceptable for accounting.

### Proposed Fix
Persist the conversion rate (and fiat amount) on each payment at confirmation time; reports use the stored historical rate. Offer current-rate view explicitly as a separate mode.

### Acceptance Criteria
- Each payment stores its fiat amount + rate at confirmation.
- Historical reports are reproducible (rate-locked).
- Current-rate view is a distinct, labeled option.

---

## Issue #95: No reconciliation/export format for accounting systems (e.g. QuickBooks/Xero/CSV schema)

**Labels:** `feature`, `backend`

### Problem
Exports are ad-hoc CSV. Schools' bursars need a stable, documented schema (or integration) to import into accounting software; column changes break their pipelines.

### Impact
Manual re-keying; broken downstream imports when columns change.

### Proposed Fix
Define a versioned export schema, document it, and provide standard accounting-friendly exports (and optionally a QuickBooks/Xero mapping).

### Acceptance Criteria
- Versioned, documented export schema.
- Backwards-compatible column changes.
- At least one accounting-software-friendly format.

---

## Issue #96: Audit log lacks immutability guarantees and integrity verification

**Labels:** `security`, `compliance`, `data-integrity`

### Problem
`auditService.js`/`auditLogModel.js` writes audit entries with a TTL index (`002`). A TTL means audit records are auto-deleted, and there's no hash-chaining/append-only guarantee preventing tampering by anyone with DB write access.

### Impact
For a financial system, auto-expiring and mutable audit logs undermine forensic/compliance value; an attacker with DB access can alter history.

### Proposed Fix
Reconsider TTL for audit data (archive instead of delete), and add tamper-evidence (hash chain linking each entry to the previous) with a verification job. Restrict audit writes to an append-only path.

### Acceptance Criteria
- Audit records are archived, not silently TTL-deleted.
- Hash-chain integrity verifiable.
- Tampering is detectable.

---

## Issue #97: Audit coverage is incomplete — several mutating actions are not audited

**Labels:** `security`, `compliance`, `backend`

### Problem
Some controllers log audit entries (`logAudit`), but coverage is inconsistent: disputes resolve without an audit entry (see `dispute.controller.js`), and fee/school/config changes may not be uniformly audited. There's no enforced "every mutation is audited" guarantee.

### Impact
Gaps in the audit trail for security-relevant actions (who changed a fee, who resolved a dispute).

### Proposed Fix
Centralize auditing via middleware on mutating routes (capturing actor, tenant, before/after), and add tests asserting representative mutations produce audit entries.

### Acceptance Criteria
- Dispute resolution, fee, school, and config changes are audited.
- Audit captures actor + before/after where applicable.
- Test asserts audit emission on mutations.

---

## Issue #98: Report endpoints don't enforce role/permission scoping for sensitive financials

**Labels:** `security`, `backend`

### Problem
Once per-school roles exist (Issue #26), financial reports and exports should be restricted to authorized roles. Currently any authenticated principal with tenant access can pull full financials.

### Impact
A read-only or limited staff account can exfiltrate complete financial data.

### Proposed Fix
Gate report/export routes behind a `finance`/`owner` permission; default least-privilege.

### Acceptance Criteria
- Report/export routes require an explicit finance permission.
- Unauthorized roles receive `403`.
- Tests cover role enforcement.

---

## Issue #99: Currency cache is per-process and unbounded in the number of currencies

**Labels:** `performance`, `backend`

### Problem
`rateCache` in `currencyConversionService.js` is an in-memory object keyed by currency with no eviction. Many distinct school currencies (and per-replica duplication) mean unbounded growth and N× CoinGecko calls across replicas (also noted in Issue #7).

### Impact
Memory growth with many currencies; redundant external calls; inconsistent rates across replicas.

### Proposed Fix
Bound the cache (LRU) and/or move to a shared Redis cache with TTL so all replicas share one fetch per currency; cap supported currencies to an allowlist.

### Acceptance Criteria
- Cache is bounded (LRU) or Redis-shared.
- Replicas share fetches.
- Supported-currency allowlist enforced.

---

## Issue #100: No validation that a school's `localCurrency` is a CoinGecko-supported `vs_currency`

**Labels:** `bug`, `backend`

### Problem
`fetchRatesFromCoinGecko` throws if CoinGecko doesn't support the currency, but the error only surfaces at conversion time. A school can be configured with an unsupported currency code and only discover it when conversions silently return `available: false`.

### Impact
Silent fiat-unavailability for misconfigured schools; confusing "rate unavailable" everywhere with no setup-time signal.

### Proposed Fix
Validate `localCurrency` against the supported `vs_currencies` list at school create/update time; warn/reject unsupported codes up front.

### Acceptance Criteria
- School currency validated at write time against supported list.
- Unsupported codes rejected with a clear error.
- List refreshed/cached periodically.

---

## Issue #101: Currency conversion uses `console.warn` instead of the structured logger

**Labels:** `tech-debt`, `observability`

### Problem
`currencyConversionService.js` logs price-feed failures with `console.warn(...)` rather than `logger.child('CurrencyConversion')`, so these warnings bypass log levels, structured fields, and centralized aggregation.

### Impact
Price-feed degradation is invisible to log-based monitoring/alerting.

### Proposed Fix
Replace `console.warn`/`console.*` with the structured logger throughout; lint-ban `console.*` in `backend/src`.

### Acceptance Criteria
- No `console.*` in the currency service (or backend).
- Price-feed failures appear in structured logs.
- ESLint rule forbids `console.*` in backend src.

---

## Issue #102: No alerting when fiat conversion is stale or unavailable system-wide

**Labels:** `observability`, `backend`

### Problem
Stale-while-revalidate masks outages by serving old rates, which is good for UX but means a prolonged CoinGecko outage is invisible until rates exceed the stale threshold and everything shows "rate unavailable".

### Impact
Operators don't know fiat display is degraded until users complain.

### Proposed Fix
Export `price_feed_last_success_timestamp` and `price_feed_stale` metrics and alert when staleness exceeds a threshold.

### Acceptance Criteria
- Staleness/availability metrics exported.
- Alert fires on prolonged staleness.
- Runbook documents response.

---

## Issue #103: Rounding to 2 decimals can misrepresent very small/large fiat values

**Labels:** `bug`, `data-integrity`

### Problem
`convertToLocalCurrency` does `parseFloat((amount * rate).toFixed(2))`. For low-value currencies or tiny XLM amounts this can round to `0.00`, and float multiplication before rounding can introduce error.

### Impact
Tiny payments display as `0.00`; accumulated rounding drifts totals.

### Proposed Fix
Use a decimal library for the multiplication, apply currency-appropriate decimal places (some currencies have 0 or 3), and avoid premature `parseFloat`.

### Acceptance Criteria
- Decimal-safe conversion.
- Per-currency decimal precision honored.
- Tiny amounts not rounded to zero unexpectedly.

---

## Issue #104: No automated test that CoinGecko response-shape changes are detected

**Labels:** `testing`, `reliability`

### Problem
The parser reads `data?.stellar?.[currency]` and `data?.['usd-coin']?.[currency]`. If CoinGecko changes IDs/shape, conversions silently fail with only a warn. There's no contract test/canary.

### Impact
A provider schema change silently disables all fiat display.

### Proposed Fix
Add a contract test against a recorded fixture and a periodic canary that fetches a known currency and alerts on shape mismatch.

### Acceptance Criteria
- Fixture-based contract test for the parser.
- Canary alerts on shape change.
- Documented response contract.

---

## Issue #105: Dispute resolution is not audited and emits no notification/webhook

**Labels:** `bug`, `compliance`, `backend`

### Problem
`dispute.controller.js#resolveDispute` updates the dispute but writes no audit entry and fires no SSE/webhook/email. The payment's status is also not changed (e.g. to `DISPUTED`/`RESOLVED`), so the dispute and payment can disagree.

### Impact
No trail of who resolved a financial dispute and why; integrators/parents aren't notified; payment and dispute states diverge.

### Proposed Fix
Audit every dispute transition (with `resolvedBy`), emit `dispute.resolved` webhook + SSE + notification, and synchronize the linked payment status per the resolution.

### Acceptance Criteria
- Dispute transitions are audited with actor + note.
- Resolution emits webhook/SSE/notification.
- Linked payment status stays consistent.

---

## Issue #106: Dispute state machine allows invalid transitions and re-opening is undefined

**Labels:** `bug`, `data-integrity`, `backend`

### Problem
`resolveDispute` only updates disputes currently `open`/`under_review`, defaulting unknown statuses to `resolved`. There's no formal state machine (e.g. can a `rejected` dispute be re-opened? can it go `under_review → open`?), and `resolvedBy` falls back to a literal `'admin'` when no user is present.

### Impact
Inconsistent dispute lifecycle; ambiguous accountability when `resolvedBy` is `'admin'`.

### Proposed Fix
Define an explicit dispute state machine with allowed transitions, require an authenticated actor for resolution (no `'admin'` fallback), and support an audited re-open path.

### Acceptance Criteria
- Transitions validated against a state machine.
- Resolution requires a real authenticated actor.
- Re-open path defined and audited.

---

## Issue #107: Disputes have no evidence/attachment support or SLA tracking

**Labels:** `feature`, `backend`

### Problem
A dispute holds only `reason`/`resolutionNote` text. Real disputes need supporting evidence (screenshots, tx references) and SLA/age tracking so they don't languish.

### Impact
Hard to adjudicate disputes fairly; no visibility into aging/overdue disputes.

### Proposed Fix
Add attachment references (object storage), structured evidence fields, and SLA/age metrics with an "overdue disputes" view.

### Acceptance Criteria
- Disputes support evidence attachments.
- Dispute age/SLA tracked and surfaced.
- Overdue disputes alertable.

---

## Issue #108: Dispute creation doesn't notify the school or freeze related automated actions

**Labels:** `enhancement`, `backend`

### Problem
`flagDispute` creates the record but doesn't notify the school (SSE/email/webhook) or pause automated actions on the disputed payment (e.g. continued reminders or downstream settlement).

### Impact
Schools learn of disputes late; automation keeps acting on a contested payment.

### Proposed Fix
On dispute creation, notify the school and set a hold flag that suppresses reminders/automation for the affected student/payment until resolved.

### Acceptance Criteria
- Dispute creation notifies the school.
- Automated actions on the disputed payment are paused.
- Hold lifts on resolution.

---

## Issue #109: Dispute `raisedBy` is unauthenticated free text — no link to a real identity

**Labels:** `security`, `data-integrity`

### Problem
`flagDispute` accepts `raisedBy` as arbitrary client text (≤200 chars). Anyone who can reach the endpoint can file disputes impersonating any name, with no rate limit or identity binding.

### Impact
Dispute spam/impersonation; no trustworthy record of who actually raised a dispute.

### Proposed Fix
Bind `raisedBy` to the authenticated principal (or a verified parent identity/email-verification flow), rate-limit dispute creation per tenant/student, and record the authenticated actor separately from any display name.

### Acceptance Criteria
- Disputes record a verified/authenticated raiser.
- Creation is rate-limited.
- Display name separated from identity.

---

## Issue #110: No metrics or reporting on dispute volume, resolution time, or outcomes

**Labels:** `observability`, `feature`

### Problem
There's no aggregate view of disputes (open count, mean time-to-resolution, rejection rate) per school, which is a key health/fraud signal.

### Impact
Operators and schools can't spot a spike in disputes (possible fraud or a systemic bug).

### Proposed Fix
Add dispute metrics and a per-school dispute summary in reports/dashboards.

### Acceptance Criteria
- Dispute counts/age/outcomes exported as metrics.
- Per-school dispute summary available.
- Spike alerting configured.

---

## Issue #111: Fee structure changes are not versioned — historical payments lose their original fee context

**Labels:** `bug`, `data-integrity`, `feature`

### Problem
`feeStructureModel.js` is updated in place (with optional cascade). Once a fee changes, there's no immutable record of what the fee *was* when a past payment was made, beyond `studentFeeHistory`. Reports can't reliably reconstruct historical obligations.

### Impact
Disputes about "what was owed at the time" can't be answered; audits can't reconstruct historical fee schedules.

### Proposed Fix
Version fee structures (effective-dated rows) so each payment references the fee version in effect; never destructively overwrite.

### Acceptance Criteria
- Fee structures are effective-dated/versioned.
- Payments reference the applicable fee version.
- Historical reconstruction is possible.

---

## Issue #112: Fee adjustment rules lack precedence/conflict resolution and a dry-run preview

**Labels:** `bug`, `feature`, `backend`

### Problem
`feeAdjustmentEngine.js`/`feeAdjustmentRuleModel.js` apply multiple rules (discounts, scholarships, surcharges) but ordering/precedence and conflict handling (two rules targeting the same student) are unclear, and there's no dry-run to preview the effect before applying.

### Impact
Non-deterministic final fees depending on rule order; admins can't preview the impact of a rule change before it hits balances.

### Proposed Fix
Define explicit rule precedence/stacking semantics, deterministic evaluation order, and a dry-run endpoint that returns the computed effect per student without persisting.

### Acceptance Criteria
- Deterministic, documented rule precedence.
- Conflicts resolved by a defined policy.
- Dry-run preview available before apply.

---

## Issue #113: Fee adjustment application across many students is not batched/transactional

**Labels:** `performance`, `data-integrity`

### Problem
Applying an adjustment rule to a cohort likely iterates students and writes individually (similar to Issue #8/#14), without batching or atomicity.

### Impact
Slow application for large cohorts; partial application on failure leaves inconsistent balances.

### Proposed Fix
Use bulk writes within a transaction (or idempotent re-runnable application), with a progress/status record for large cohorts.

### Acceptance Criteria
- Cohort application uses bulk writes.
- Atomic or idempotently re-runnable.
- Progress/status visible for large applications.

---

## Issue #114: No validation that `amountPaid` never exceeds `totalFee` after adjustments

**Labels:** `bug`, `data-integrity`

### Problem
When fees are adjusted downward after a parent already paid, `amountPaid` can exceed the new `totalFee`, implying a credit/overpayment that isn't modeled (related to Issue #57).

### Impact
Negative `remainingBalance` and unmodeled credits; reminders/reports misbehave.

### Proposed Fix
On adjustment, detect resulting overpayments, clamp `remainingBalance` at 0, and create an explicit credit/overpayment record for follow-up.

### Acceptance Criteria
- Adjustments resulting in overpayment are detected.
- `remainingBalance` never goes negative.
- Overpayment surfaced as an explicit credit.

---

## Issue #115: Source-validation rules (sender allowlists) lack tenant-isolation and abuse tests

**Labels:** `security`, `multi-school`, `testing`

### Problem
`sourceValidationRuleModel.js`/`Controller` + migration `004` imply per-school rules restricting which sender addresses are valid. Tenant isolation of these rules, plus behavior when a payment matches no rule (accept vs flag), needs tests.

### Impact
A misconfigured/leaked rule set could accept payments from unintended senders or block legitimate ones; cross-tenant rule leakage would be a security issue.

### Proposed Fix
Ensure rules are strictly tenant-scoped, define default behavior for unmatched senders, and add isolation + behavior tests.

### Acceptance Criteria
- Source rules are tenant-isolated (tested).
- Unmatched-sender behavior is defined and documented.
- Abuse/edge tests added.

---

## Issue #116: Reminder scheduling uses a fixed global interval, ignoring per-school timezone and quiet hours

**Labels:** `enhancement`, `multi-school`

### Problem
`reminderService.js` runs on `reminderIntervalMs` (global default 24h) with no awareness of each school's timezone or acceptable send window. Reminders can fire in the middle of the night for some tenants (related to Issues #3, #46).

### Impact
Poor parent experience (3 AM emails), lower engagement, and possible spam complaints.

### Proposed Fix
Schedule reminders relative to each school's timezone and configured quiet hours; batch per-tenant sends within their window.

### Acceptance Criteria
- Reminders respect per-school timezone + quiet hours.
- Configurable send window per tenant.
- Test covers two tenants in different timezones.

---

## Issue #117: No reminder escalation policy or cap — parents can be reminded indefinitely

**Labels:** `enhancement`, `compliance`

### Problem
There's no documented escalation (e.g. reminders at T-7, T-1, overdue) or a maximum number of reminders per student/fee. A perpetually-unpaid fee could generate endless reminders.

### Impact
Reminder fatigue, spam complaints, and deliverability damage.

### Proposed Fix
Define an escalation schedule and a per-fee reminder cap; stop after the cap or after the fee is disputed/closed (ties to Issue #108).

### Acceptance Criteria
- Reminder schedule/escalation defined.
- Per-fee reminder cap enforced.
- Disputed/closed fees suppress reminders.

---

## Issue #118: Reminder sends are not idempotent — restart/overlap can double-send

**Labels:** `bug`, `reliability`

### Problem
If the reminder scheduler runs on multiple replicas (Issue #47) or restarts mid-batch, a student could receive duplicate reminders because there's no per-(student, reminder-window) idempotency record.

### Impact
Duplicate reminder emails erode trust and trip spam filters.

### Proposed Fix
Record a `reminderSent` marker per (student, fee, window) and skip if already sent; make the batch leader-locked and resumable.

### Acceptance Criteria
- Each reminder window sends at most once per student.
- Restart mid-batch doesn't duplicate.
- Leader-locked execution (see Issue #47).

---

## Issue #119: No delivery tracking (sent/opened/bounced) for reminders or receipts

**Labels:** `observability`, `feature`

### Problem
The system has no record of whether a reminder/receipt email was delivered, bounced, or opened, so schools can't tell if parents are actually receiving communications.

### Impact
Schools chase parents who never got the email; no signal to suppress dead addresses.

### Proposed Fix
Persist delivery status from the email provider (webhooks for delivered/bounced/complaint), surface it per student, and feed bounces into suppression (Issue #80).

### Acceptance Criteria
- Delivery status persisted per email.
- Bounces feed the suppression list.
- Status visible per student.

---

## Issue #120: Reminder content is hardcoded — no per-school branding/templating or localization

**Labels:** `enhancement`, `feature`, `multi-school`

### Problem
Reminder/receipt emails appear hardcoded in English with no per-school branding (logo, name, support contact) or localization, despite the system being multi-tenant and multi-currency/multi-region.

### Impact
Generic, unbranded emails reduce trust; non-English-speaking parents are underserved.

### Proposed Fix
Externalize templates with per-school branding variables and i18n; allow schools to customize subject/body within safe bounds.

### Acceptance Criteria
- Templates support per-school branding.
- Localization supported (at least template-level).
- Customization is sanitized/safe.

---

## Issue #121: No notification channels beyond email (SMS / WhatsApp) for fee reminders

**Labels:** `feature`, `enhancement`

### Problem
In many target markets (the README references Papua New Guinea, Nigeria), SMS/WhatsApp reach parents far more reliably than email, but only email is supported.

### Impact
Low reminder reach in mobile-first markets; reduced on-time payment rates.

### Proposed Fix
Add a pluggable notification-channel abstraction (`notificationService.js`) supporting SMS/WhatsApp providers with per-school channel preferences.

### Acceptance Criteria
- Pluggable channel abstraction with at least one SMS provider.
- Per-school channel preference.
- Opt-out honored across channels (Issue #9).

---

## Issue #122: No distributed tracing / correlation IDs across the request → poller → webhook chain

**Labels:** `observability`, `backend`

### Problem
`requestLogger`/`morgan` log per request, but there's no propagated correlation/trace ID linking an HTTP request to the resulting poller processing, queue job, webhook delivery, and SSE emit. Debugging a single payment across async boundaries is hard.

### Impact
Operators can't trace one payment's journey end-to-end; incident triage is slow.

### Proposed Fix
Generate/propagate a correlation ID (and optionally OpenTelemetry spans) through HTTP, queue jobs, webhook deliveries, and logs; include it in `X-StellarEduPay-Delivery-ID` linkage.

### Acceptance Criteria
- Correlation ID propagated across async boundaries.
- Logs for one payment are linkable by ID.
- (Optional) OpenTelemetry spans exported.

---

## Issue #123: Prometheus metric cardinality and coverage need an audit

**Labels:** `observability`, `backend`

### Problem
`metrics/index.js` + `prom-client` export metrics, but coverage (per-stage payment funnel, queue depth, Horizon latency, webhook outcomes) and cardinality safety (no per-student/per-tx labels) need a deliberate audit.

### Impact
Either blind spots (no metric for a failure mode) or cardinality explosions (labels with unbounded values) that destabilize Prometheus.

### Proposed Fix
Define a metrics catalog covering the payment funnel, queues, Horizon, webhooks, SSE, and price feed; ban high-cardinality labels; document each metric.

### Acceptance Criteria
- Documented metrics catalog with bounded labels.
- Payment funnel + queue + Horizon + webhook metrics exist.
- No unbounded-cardinality labels.

---

## Issue #124: Alerting rules and dashboards exist in `monitoring/` but aren't validated/tested in CI

**Labels:** `observability`, `devops`, `testing`

### Problem
There's a `monitoring/` dir and `docker-compose.monitoring.yml`, but no CI validation that alert rules are syntactically valid, reference existing metrics, and that dashboards load. Drift between exported metrics and dashboards/alerts is likely.

### Impact
Dashboards reference renamed/removed metrics; alert rules silently never fire.

### Proposed Fix
Add CI steps to lint/validate Prometheus rules (`promtool`) and check that dashboards reference exported metric names.

### Acceptance Criteria
- CI validates alert rule syntax + metric references.
- Dashboards checked against exported metrics.
- Drift fails the build.

---

## Issue #125: No SLOs/error budgets defined for the payment-confirmation pipeline

**Labels:** `observability`, `docs`

### Problem
There are no documented SLOs (e.g. "99% of on-chain payments reflected in-app within 60s") or error budgets, so there's no objective definition of "the system is healthy" or when to halt feature work.

### Impact
No shared target for reliability; incident severity and prioritization are subjective.

### Proposed Fix
Define SLOs for sync latency, webhook delivery, and API availability; instrument SLIs; document error budgets and burn-rate alerts.

### Acceptance Criteria
- SLOs documented with SLIs instrumented.
- Burn-rate alerts configured.
- Reviewed periodically.

---

## Issue #126: Logs are unstructured in places and log levels are inconsistent

**Labels:** `observability`, `tech-debt`

### Problem
The codebase mixes `logger.child(...)` structured logging with `console.warn`/`console.log` (currency service, possibly others) and `morgan` text logging. Log levels (`info` vs `warn` vs `error`) are applied inconsistently.

### Impact
Hard to aggregate/search logs; noisy or missing signals; inconsistent severity routing.

### Proposed Fix
Standardize on the structured logger with JSON output in production, consistent level semantics, and ban `console.*` (Issue #101). Route `morgan` through the structured logger.

### Acceptance Criteria
- All backend logging is structured/JSON in prod.
- Consistent level semantics documented.
- `morgan` integrated with the logger.

---

## Issue #127: No PII scrubbing in error tracking / no error-tracking integration

**Labels:** `observability`, `security`

### Problem
There's no integration with an error-tracking system (Sentry-style) with PII scrubbing. Errors are only in logs, making aggregation, alerting, and regression detection harder.

### Impact
Errors are discovered by reading logs; no automatic grouping/alerting on new error types.

### Proposed Fix
Add error tracking with strict PII scrubbing (no student IDs/emails/tokens in events), release tagging, and source maps for the frontend.

### Acceptance Criteria
- Error tracking integrated with PII scrubbing.
- New error types alert automatically.
- Frontend errors captured with source maps.

---

## Issue #128: `heapMonitoring` logs leaks but there's no automatic mitigation or profiling hook

**Labels:** `observability`, `reliability`

### Problem
`utils/heapMonitoring.js` (`startHeapMonitoring`) detects heap growth but it's unclear it exports a metric, triggers an alert, or can capture a heap snapshot for diagnosis.

### Impact
A slow leak is detected only in logs; root-causing requires manual intervention before OOM.

### Proposed Fix
Export heap metrics, alert on sustained growth, and provide a guarded endpoint/signal to capture a heap snapshot for offline analysis.

### Acceptance Criteria
- Heap usage exported as a metric and alertable.
- On-demand heap snapshot capture (guarded).
- Documented leak-triage runbook.

---

## Issue #129: No load/stress test characterizing start-of-term payment spikes

**Labels:** `performance`, `testing`

### Problem
School fee payments are extremely bursty (term start). There's no load test characterizing the system under a spike of concurrent payments/syncs to find the breaking point and validate autoscaling.

### Impact
The system may fall over exactly when it matters most, with no prior knowledge of limits.

### Proposed Fix
Add a load-test harness (k6/Artillery) simulating burst payment + sync + report load against a staging stack, with documented capacity numbers.

### Acceptance Criteria
- Reproducible load test for burst scenarios.
- Documented capacity limits + bottlenecks.
- Run in a pre-release pipeline.

---

## Issue #130: N+1 query patterns in payment/student enrichment

**Labels:** `performance`, `backend`

### Problem
Enrichment (e.g. `enrichPaymentWithConversion` per payment, student lookups per payment) is likely applied row-by-row, producing N external/DB calls per list response. Currency conversion is async per item.

### Impact
List endpoints scale poorly; each row triggers a conversion/lookup, multiplying latency and load.

### Proposed Fix
Batch conversions (one rate fetch per currency for the whole page), use `$lookup`/`populate` or a single batched student query, and memoize per-request.

### Acceptance Criteria
- Per-page conversion uses one rate lookup per currency.
- Student/fee joins are batched.
- List latency is O(1) external calls per page.

---

## Issue #131: No HTTP caching / ETags on read-heavy, slowly-changing endpoints

**Labels:** `performance`, `backend`

### Problem
Endpoints like fee structures, school config, and payment instructions change rarely but are likely re-fetched often with no `ETag`/`Cache-Control`/conditional-request support.

### Impact
Unnecessary load and bandwidth for data that rarely changes.

### Proposed Fix
Add `ETag`/`Last-Modified` and `Cache-Control` to safe, slowly-changing reads; support `If-None-Match` → `304`.

### Acceptance Criteria
- Slowly-changing reads support conditional requests.
- Appropriate `Cache-Control` set.
- `304` returned on unchanged resources.

---

## Issue #132: No compression for API responses

**Labels:** `performance`, `backend`

### Problem
There's no `compression` middleware, so large JSON payloads (payment lists, reports) are sent uncompressed.

### Impact
Higher bandwidth and slower responses, especially for large tenants on poor connections (relevant to target markets).

### Proposed Fix
Add gzip/br compression middleware with a size threshold; ensure it interacts safely with SSE (don't buffer SSE streams).

### Acceptance Criteria
- JSON responses compressed above a threshold.
- SSE streams not buffered by compression.
- Bandwidth reduction measured.

---

## Issue #133: Connection/keep-alive and timeout tuning for upstream HTTP (Horizon, CoinGecko, webhooks) is inconsistent

**Labels:** `performance`, `reliability`, `backend`

### Problem
Outbound HTTP uses a mix of `axios` (webhooks), native `https` (currency), and the Stellar SDK (Horizon), each with different timeout/keep-alive/agent settings. No shared agent with connection pooling means TCP/TLS handshakes repeat.

### Impact
Higher latency and socket churn under load; inconsistent timeout behavior makes failures unpredictable.

### Proposed Fix
Standardize on a shared HTTP client with keep-alive agents, consistent timeouts, and retry policy across all upstreams.

### Acceptance Criteria
- Shared keep-alive agent for outbound HTTP.
- Consistent timeout/retry policy documented.
- Reduced handshake overhead measured.

---

## Issue #134: No request timeout / slow-loris protection at the server layer

**Labels:** `security`, `performance`, `backend`

### Problem
Express doesn't set `server.headersTimeout`/`requestTimeout`/`keepAliveTimeout`, so slow-loris-style clients can hold connections open, and long-running handlers have no server-enforced ceiling.

### Impact
Connection exhaustion via slow clients; runaway handlers tie up resources.

### Proposed Fix
Set Node HTTP server timeouts and a per-route request-timeout middleware that aborts overly-long requests with `503`.

### Acceptance Criteria
- Server-level timeouts configured.
- Per-route request timeout enforced.
- Slow-loris test bounded.

---

## Issue #135: Duplicate/overlapping migrations indicate a fragile migration process

**Labels:** `tech-debt`, `devops`, `data-integrity`

### Problem
`backend/migrations/` has collisions and ad-hoc files: two `002_*`, two `015_*`, plus non-numbered `add-timezone-to-schools.js` / `add-timezone-to-schools` overlapping with `013_add_school_timezone.js`. Ordering/idempotency is ambiguous, and `migrationRunner.js`/`migrationModel.js` behavior under duplicate prefixes is unclear.

### Impact
Migrations may apply out of order, twice, or be skipped; environments drift; a fresh deploy may not reproduce production schema/indexes.

### Proposed Fix
Enforce unique, monotonic migration IDs, make every migration idempotent, remove/merge the duplicate/ad-hoc files, and have the runner record + verify a checksum per applied migration with a CI check that pending migrations apply cleanly on a fresh DB.

### Acceptance Criteria
- Migration IDs are unique and ordered; duplicates removed.
- Runner records and verifies applied migrations idempotently.
- CI applies all migrations on a clean DB successfully.

---

## Issue #136: No down/rollback path for migrations

**Labels:** `devops`, `data-integrity`

### Problem
Migrations appear forward-only with no rollback/`down` step. A bad migration (e.g. a wrong index or destructive backfill) can't be cleanly reverted.

### Impact
A faulty migration requires manual DB surgery to undo; risky deploys.

### Proposed Fix
Add `down` functions (or documented compensating migrations) and test apply→rollback→apply in CI for new migrations.

### Acceptance Criteria
- New migrations include a rollback path.
- CI tests apply/rollback cycles.
- Destructive migrations are gated/confirmed.

---

## Issue #137: Index strategy is not consolidated or verified against actual query plans

**Labels:** `performance`, `data-integrity`

### Problem
Indexes are spread across many migrations (`002`, `004`, `007`, `014`, `015`, `016`) and model `index()` calls. There's no single source of truth, and no test asserting hot queries are index-covered (no COLLSCAN).

### Impact
Redundant/unused indexes (write amplification + storage) or missing indexes for real queries; silent performance cliffs as data grows.

### Proposed Fix
Document the index catalog, remove redundant indexes, and add `explain()`-based tests for the hottest queries (payments by school/status/date, students by school, audit by action/date).

### Acceptance Criteria
- Index catalog documented and de-duplicated.
- Hot queries proven index-covered via `explain`.
- Unused indexes removed.

---

## Issue #138: Encryption-at-rest key management (`MEMO_ENCRYPTION_KEY`) lacks rotation and KMS integration

**Labels:** `security`, `compliance`

### Problem
`utils/memoEncryption.js` encrypts memos with `MEMO_ENCRYPTION_KEY` from env (migration `011` encrypts existing memos). There's no key rotation strategy, key-versioning on ciphertext, or KMS-managed keys — rotating the key would orphan all existing ciphertext.

### Impact
Compromised key can't be rotated without a full re-encryption migration; no key versioning means rotation is all-or-nothing and risky.

### Proposed Fix
Add a key-ID/version prefix to ciphertext, support multiple active keys during rotation, and integrate a KMS/secret manager rather than raw env.

### Acceptance Criteria
- Ciphertext carries a key version.
- Rotation supported without data loss.
- Keys sourced from a KMS/secret manager.

---

## Issue #139: No automated backup/restore verification for MongoDB

**Labels:** `devops`, `reliability`, `data-integrity`

### Problem
The README mentions backup/recovery, but there's no evidence of automated, tested restores. An untested backup is not a backup.

### Impact
A data-loss incident could reveal that backups are incomplete or unrestorable — catastrophic for financial records.

### Proposed Fix
Automate periodic backups (including indexes), and a scheduled restore-verification job into a scratch environment that asserts row counts/integrity. Document RPO/RTO.

### Acceptance Criteria
- Automated backups with retention.
- Scheduled restore verification passes.
- Documented RPO/RTO.

---

## Issue #140: Frontend has no global auth guard / route protection consistency

**Labels:** `security`, `frontend`

### Problem
`useAdminAuth.js` exists, but it's unclear every protected page (dashboard, fees, reports, audit-logs, disputes, fee-adjustments) consistently enforces auth and redirects unauthenticated users. Client-side guards alone are insufficient without the backend fixes (Issues #5, #26).

### Impact
Protected pages may render briefly or fully for unauthenticated users; inconsistent UX and a false sense of protection.

### Proposed Fix
Add a single auth-guard wrapper (HOC/layout) applied to all protected routes that redirects to `/login` and waits for auth resolution before rendering protected content.

### Acceptance Criteria
- All protected routes use one guard.
- Unauthenticated users are redirected before protected content renders.
- Guard handles token-expiry/refresh.

---

## Issue #141: Frontend lacks a typed/validated API client and centralized error handling

**Labels:** `frontend`, `tech-debt`

### Problem
`services/api.js` likely hand-rolls fetch calls. Without a typed client (or at least centralized request/response handling), error formats, auth-refresh, and retry behavior are duplicated and drift; `utils/errorMessages.js`/`stellarErrors.js` partially address this.

### Impact
Inconsistent error UX, duplicated auth/refresh logic, and brittle coupling to backend response shapes.

### Proposed Fix
Centralize an API client that handles auth headers, 401→refresh, error normalization, and (optionally) generate types from the OpenAPI spec (`/api/docs.json`).

### Acceptance Criteria
- Single API client handles auth/refresh/errors.
- Error normalization consistent across pages.
- (Optional) Types generated from OpenAPI.

---

## Issue #142: Frontend has no loading/empty/error states standardization and limited accessibility

**Labels:** `frontend`, `enhancement`

### Problem
Pages likely handle loading/error/empty states ad-hoc, and there's no evidence of accessibility (ARIA, keyboard nav, focus management) or i18n for the parent-facing payment flow.

### Impact
Inconsistent UX, poor accessibility (legal/inclusivity risk), and English-only UI in multilingual markets.

### Proposed Fix
Standardize loading/empty/error components, add an accessibility pass (semantic HTML, ARIA, focus), and introduce i18n scaffolding for the parent flow.

### Acceptance Criteria
- Shared loading/empty/error components used across pages.
- Key flows pass an accessibility audit (axe).
- i18n scaffolding in place for the payment flow.

---

## Issue #143: Frontend SSE/real-time updates lack reconnection/backoff and auth handling

**Labels:** `frontend`, `reliability`

### Problem
The backend provides SSE per school, but the frontend's `EventSource` usage needs robust reconnection with backoff, auth on the SSE connection, and handling of the server's heartbeat/`retry`. A dropped connection should transparently resume.

### Impact
Real-time payment updates silently stop after a network blip; users see stale data until a manual refresh.

### Proposed Fix
Implement reconnection with exponential backoff + jitter, authenticate the SSE connection, and reconcile missed events via a REST refetch on reconnect.

### Acceptance Criteria
- SSE auto-reconnects with backoff.
- Connection is authenticated and tenant-scoped.
- Missed events reconciled on reconnect.

---

## Issue #144: Payment URI / QR generation correctness and wallet-compatibility tests are thin

**Labels:** `frontend`, `testing`, `stellar-integration`

### Problem
`utils/stellarUri.js` builds the SEP-0007 `web+stellar:` URI / QR (recent PR #766 added copy/download). Coverage for memo encoding, asset/amount formatting, and compatibility across wallets (Lobstr, Freighter, etc.) is limited, and an incorrect URI silently fails in the parent's wallet.

### Impact
A malformed payment URI sends parents to a broken/empty wallet prompt, or with the wrong amount/memo — causing failed or misrouted payments.

### Proposed Fix
Add thorough unit tests for SEP-0007 URI construction (memo type/text, asset, amount precision, destination), and document tested wallet compatibility.

### Acceptance Criteria
- SEP-0007 URI construction fully unit-tested.
- Memo/asset/amount edge cases covered.
- Documented wallet-compatibility matrix.

---

## Issue #145: Frontend has no build-time env validation or secret-leak guard

**Labels:** `frontend`, `security`, `devops`

### Problem
Next.js exposes `NEXT_PUBLIC_*` vars to the browser. Without a build-time check, a sensitive value could be accidentally prefixed and shipped to clients, and missing required public config fails only at runtime.

### Impact
Accidental secret exposure in the client bundle, or runtime crashes from missing config.

### Proposed Fix
Validate required public env at build time and add a guard/test that fails the build if a known-secret pattern is exposed as `NEXT_PUBLIC_*`.

### Acceptance Criteria
- Build validates required public env.
- Build fails if a secret-like value is publicly exposed.
- Documented env contract for the frontend.

---

## Issue #146: Test suite has loose isolation and relies on `--forceExit` (leaked handles)

**Labels:** `testing`, `tech-debt`

### Problem
`package.json` runs Jest with `--forceExit`, which masks leaked handles (open Redis/Mongo/SSE timers). The `blockRealHttp.js` setup is good, but `--forceExit` hides resource-cleanup bugs that also affect production graceful shutdown (Issue #85).

### Impact
Real leaks (timers, sockets) are hidden in tests and surface as shutdown hangs/leaks in production.

### Proposed Fix
Remove `--forceExit`, fix open-handle leaks (use `--detectOpenHandles` to find them), ensure every service exposes a `close()` used in `afterAll`.

### Acceptance Criteria
- Tests pass without `--forceExit`.
- No open-handle warnings.
- Services close cleanly in teardown.

---

## Issue #147: No enforced coverage threshold or coverage reporting in CI

**Labels:** `testing`, `devops`

### Problem
There are many test files but no coverage gate. Critical money-path modules (`stellarService`, `concurrentPaymentProcessor`, `transactionManager`, idempotency, webhooks) may be under-covered without anyone noticing.

### Impact
Coverage silently regresses; high-risk modules ship under-tested.

### Proposed Fix
Enable Jest coverage with per-directory thresholds (higher for money-path modules), publish reports, and fail CI below threshold.

### Acceptance Criteria
- Coverage measured and published in CI.
- Thresholds enforced (stricter for money-path code).
- Build fails on regression.

---

## Issue #148: Integration tests against real Horizon are opt-in and not run/scheduled in CI

**Labels:** `testing`, `stellar-integration`, `devops`

### Problem
`test:integration` (real Horizon) and docker-compose healthcheck tests are gated behind env flags and excluded from the default run. Nothing scheduled exercises the real Stellar testnet path, so SDK/network regressions are caught late.

### Impact
A breaking change in Horizon/SDK behavior isn't detected until production sync breaks.

### Proposed Fix
Add a scheduled (nightly) CI job running the testnet integration suite against Stellar testnet with retries/quarantine for flakiness, separate from the fast PR pipeline.

### Acceptance Criteria
- Nightly integration job runs against testnet.
- Flaky tests quarantined, not blocking PRs.
- Failures alert maintainers.

---

## Issue #149: Repository has accumulated redundant/contradictory documentation and stray artifacts

**Labels:** `docs`, `tech-debt`

### Problem
The root holds overlapping, partly-stale docs and artifacts: `GITHUB_ISSUES.md` (with tripled duplicate issues), `issues.md`, `IMPLEMENTATION_SUMMARY.md`, `PR_DESCRIPTION.md`, an empty `pr.md`, `test_results.txt` (committed test output, 253KB), and feature-specific markdown (`STELLAR_FUNDING_VERIFICATION.md`, `SUSPICIOUS_PAYMENT_MULTIPLIER.md`). This is hard for contributors to navigate and the issue files contradict each other.

### Impact
New contributors get conflicting guidance; committed build artifacts bloat the repo; the duplicated issue files (this file supersedes them) cause confusion.

### Proposed Fix
Consolidate issue tracking into this `PROJECT_ISSUES.md` (or real GitHub Issues once re-enabled), remove `test_results.txt`/`pr.md` and add them to `.gitignore`, and move design docs under `docs/` with an index. Establish a docs structure and ownership.

### Acceptance Criteria
- Duplicate/stale issue files removed or archived; one source of truth.
- Build artifacts (`test_results.txt`, empty `pr.md`) removed and git-ignored.
- Design docs organized under `docs/` with an index.

---

## Issue #150: No documented architecture, threat model, runbooks, or onboarding for operators

**Labels:** `docs`, `devops`, `compliance`

### Problem
Despite an extensive README, there's no consolidated architecture diagram of the async pipeline (poller ↔ queue ↔ webhook ↔ SSE), no threat model for a money-moving multi-tenant system, and no operational runbooks (Redis down, Horizon down, stuck payments, key rotation, restore). GitHub Issues are also disabled on the active fork, so there's no contribution intake path.

### Impact
On-call operators have no playbook for the failure modes catalogued in this backlog; security review lacks a threat model; contributors can't file issues.

### Proposed Fix
Author (1) an architecture doc covering the full async money path with sequence diagrams, (2) a threat model (STRIDE) for the multi-tenant payment system, (3) runbooks for each major dependency failure and operational task referenced across these issues, and (4) re-enable an issue intake path (GitHub Issues or a documented alternative).

### Acceptance Criteria
- Architecture doc with end-to-end sequence diagrams.
- Threat model covering auth, multi-tenancy, custody, and webhooks.
- Runbooks for Redis/Horizon/Mongo outages, stuck payments, key rotation, and restore.
- A working issue-intake path documented.

---

## Summary

| Range | Theme | Count |
|-------|-------|-------|
| 1–25 | Previously-tracked (cleaned, de-duplicated) | 25 |
| 26–40 | Security & Authentication | 15 |
| 41–48 | Multi-Tenancy & Isolation | 8 |
| 49–56 | Stellar / Blockchain Integration | 8 |
| 57–72 | Payment Lifecycle & Idempotency | 16 |
| 73–80 | Webhooks & Notifications | 8 |
| 81–90 | Reliability, Queues & Retries | 10 |
| 91–98 | Reports, Audit & Analytics | 8 |
| 99–104 | Currency & Pricing | 6 |
| 105–110 | Disputes | 6 |
| 111–116 | Fees & Adjustments | 6 |
| 116–121 | Reminders & Notifications | 6 |
| 122–128 | Observability & Metrics | 7 |
| 129–134 | Performance & Scaling | 6 |
| 135–139 | Data Model & Migrations | 5 |
| 140–145 | Frontend | 6 |
| 146–148 | Testing & CI | 3 |
| 149–150 | DevOps & Documentation | 2 |

**Total: 150 issues.** Items 1–25 preserve the existing backlog; 26–150 are new findings from the 2026-06-24 audit. Recommended next step: triage into milestones — **P0 security/data-integrity** (#5, #26, #27, #41, #52, #55, #58, #88), **P1 reliability** (#11, #47, #66, #74, #83, #84, #135), then enhancements.

