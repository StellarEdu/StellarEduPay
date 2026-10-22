# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Release process (#1634)**: semantic-versioned releases via release-please (`.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`) driven by conventional commits; the previous `[Unreleased]` history is now `v1.0.0`. New `GET /api/version` (`{ service, version, commit, buildTime, node }`), `version`/`commit` on `GET /health/live`, and a `build_info{version,commit,node_version}` metric. Release images are pushed to GHCR tagged with the version and `sha-<commit>`. See [docs/releasing.md](docs/releasing.md).
- **Coverage ratchet (#1635)**: `scripts/coverage-ratchet.js` + `coverage-baseline.json` fail CI when global coverage or the coverage of a changed file decreases, and post a coverage table as a PR comment. `npm run coverage:ratchet -- --update` raises the baseline and syncs the Jest floors. New `tests/routerInventory.test.js` fails on unmounted, unloadable or empty routers.
- **Distributed tracing (#1636)**: optional OpenTelemetry tracing (`OTEL_TRACING_ENABLED`, off by default) with auto-instrumentation for HTTP/Express, MongoDB/Mongoose, ioredis and axios; trace context carried through BullMQ jobs and outbox events; spans for Horizon calls (endpoint, attempt, failover) and `withStellarRetry`; `trace_id`/`span_id` on every log line and `correlation.id` on spans. Jaeger added to `docker-compose.monitoring.yml`. See [docs/tracing.md](docs/tracing.md).
- **Parent self-service portal (#1637)**: `/parent` page and `/api/parent/*` API behind signed, expiring, revocable per-family magic links (`ParentAccessToken` model). Parents see balances, payment plans and payment history, download receipts, raise disputes and toggle reminders for their own children only; staff issue (`POST /api/parent/links`), list and revoke links. Optional portal links in reminder emails (`PARENT_PORTAL_EMAIL_LINKS`). See [docs/parent-portal.md](docs/parent-portal.md).

### Fixed

- **Path-payment crediting wired in (#1747 / #1557)**: `extractValidPayment`, `verifyTransaction`, and the destination-check branch in `syncPaymentsForSchool` in `stellarService.js` now recognise `path_payment_strict_send` and `path_payment_strict_receive` in addition to plain `payment` operations. Previously only `op.type === "payment"` was accepted, so Stellar path payments that delivered XLM or USDC to the school wallet were silently dropped instead of being credited. For both path-payment types Horizon surfaces the destination wallet and received asset/amount on the same `to`, `asset_*`, and `amount` fields as a regular payment, so `detectAsset` and fee validation work without further changes. A `CREDITABLE_OP_TYPES` `Set` replaces the three separate hard-coded `op.type === "payment"` checks.

- **Report cache invalidation wired in (#1747)**: `services/reportCacheInvalidator.js` created and subscribed to the `payment.saved` event via `paymentSavedSubscribers.js`. Calls `cache.delByPrefix('report:<schoolId>:')` so school-scoped report cache entries are dropped immediately when a new payment lands rather than waiting for the 5-minute TTL.

- **Truncated source files**: `backend/src/middleware/rateLimiter.js` had lost `publicStudentLimiter` and its entire `module.exports`, and `backend/src/routes/paymentRoutes.js` had lost its lock/unlock, status, refund, receipt-verification and reconciliation routes plus `module.exports`; both are restored. `backend/src/routes/disputeRoutes.js` used `requireSchoolAuth` without importing it.

### Removed

- **Dead phantom service code noted (#1747)**: Audit confirmed the following modules were **never written to disk** (they were described in the issue but only existed as aspirational references in docs and a draft CHANGELOG entry). No files were deleted; no tests were broken:
  - `services/stellarRateLimitedClient.js` — rate-limit token bucket; replaced entirely by `horizonPollBudget.js` (cross-school coordinated budget) and `horizonFailoverClient.js` (per-endpoint circuit breaker).
  - `services/stellarTransactionManager.js` — outgoing transaction building; the backend is read-only and never submits transactions, so this was never appropriate.
  - `services/underpaidReconciliationService.js` — partial payments are accepted as `SUCCESS` on-chain; the `underpaidReconciliation` sub-document is populated by the refund service only when a refund is processed. See `docs/payment-plans-underpaid-reconciliation.md`.
  - `services/reminderScheduler.js` — `reminderService.js` already exports `startReminderScheduler`/`stopReminderScheduler`, which `app.js` calls directly.
  - `utils/responseHelper.js` — controllers use `res.json()` directly; a wrapper was never needed.

<!-- release-please appends new entries above this line on every release (#1634). -->

## [1.0.0] - 2026-10-17

First tagged release (#1634). Everything below was previously held under `[Unreleased]`; it is now the content of `v1.0.0`.

### Security

- **Per-endpoint webhook secrets encrypted at rest (#1538)**: `WebhookEndpoint.secret` is now encrypted with `webhookSecretEncryption` (AES-256-GCM, `WEBHOOK_SECRET_ENCRYPTION_KEY`) via the same `pre('save')`/`post('init')` pattern as `School.webhookSecret`, and is `select: false` so list queries never load it. Caller-supplied secrets must be ≥ 32 characters with enough estimated entropy (`400 WEAK_WEBHOOK_SECRET` otherwise); omitted secrets are generated server-side. New `POST /api/webhook-endpoints/:id/rotate-secret` returns a new server-generated secret once and dual-signs deliveries (`X-StellarEduPay-Signature-V2-Previous`) for a configurable overlap (`WEBHOOK_SECRET_ROTATION_OVERLAP_S`, default 24h). `scripts/rotate-webhook-encryption-key.js` now re-encrypts endpoint secrets too. Webhook retries now resolve the signing secret at send time instead of relying on a field that is never persisted.
  - **`030_encrypt_webhook_endpoint_secrets`** — encrypts existing `webhookendpoints.secret` / `previousSecret` values. **Prerequisite**: `WEBHOOK_SECRET_ENCRYPTION_KEY` set, otherwise a logged no-op. Idempotent (`enc:` values skipped); `down()` decrypts back to plaintext.
- **Email bounce/complaint webhook no longer fails open (#1537)**: `POST /api/email/webhooks/:provider` now verifies Amazon SNS signatures (cert host pinned to `sns.<region>.amazonaws.com`, `TopicArn` allow-listed via `EMAIL_SNS_TOPIC_ARNS`) and auto-confirms `SubscriptionConfirmation` messages after verification; verifies SendGrid Signed Event Webhook signatures (`EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY`); accepts `EMAIL_WEBHOOK_SECRET` only via the `X-Webhook-Token` header with a constant-time comparison and rejects `?token=`. In production, unauthenticated calls are always rejected and the route returns `503` when no authentication is configured. Rejections are logged and counted in `email_webhook_rejections_total{provider, reason}`. Secret-bearing query parameters are redacted from access logs.
- **Public `/health` no longer discloses internal topology (#1540)**: `GET /health` returns only `{ status }` (200/503). The detailed report moved to `GET /api/admin/health/details` (admin auth), and raw dependency error messages are replaced with stable reason codes everywhere (including `/health/ready`, which no longer lists Horizon endpoints). The Ingress continues to route only `/api` to the backend, so `/health*` is not externally reachable.

### Deprecated

- **Webhook V1 signature sunset plan (#1539)** — see [Migration guide: V1 → V2](docs/WEBHOOK_INTEGRATION.md#migration-guide-v1--v2). Endpoints now have a `signatureVersions` setting: new endpoints receive V2 only, existing endpoints were migrated to `["v1", "v2"]` and can opt out with `PUT /api/webhook-endpoints/:id { "signatureVersions": ["v2"] }`. V1 is never emitted after `WEBHOOK_V1_SUNSET` (default `2027-02-28`). Operators list endpoints still on V1 with `GET /api/admin/webhooks/v1-endpoints` and send the advance-notice emails with `POST /api/admin/webhooks/v1-endpoints/notify`; `webhook_deliveries_total` gained a `signature_version` label. V1 is now computed over the transmitted raw body.
  - **`031_backfill_webhook_signature_versions`** — sets `signatureVersions: ["v1", "v2"]` on existing endpoints and adds a `{ signatureVersions, isActive }` index. Idempotent; `down()` removes the field from endpoints that never changed it.

### Added

- **Migrations 019–025 documentation (#1388)**: CHANGELOG and `docs/migrations.md` previously had no record of what migrations `019` through `025` do. Documented here so operators upgrading can tell what will run before they run `npm run migrate`:
  - **`019_add_reminder_time_window`** — Backfills `schools.settings.reminderTimeWindow` to `{ startHour: 8, endHour: 18 }` for any school missing it. Data-only, no index changes. Safe during a rolling deploy; idempotent (`$exists: false` filter). No prerequisites.
  - **`020_tenant_isolate_source_validation_rules`** — Fixes a tenant-isolation bug (#904): `sourcevalidationrules` had a global-unique index on `name`, so a rule created by one school collided with (and was visible to) another. Drops the old global `name_1` unique index, creates a compound unique index on `{ schoolId, name }` plus a lookup index on `{ schoolId }`, and backfills any rule missing `schoolId` to `DEFAULT_SCHOOL_ID` (falls back to `"SCH-DEFAULT"`). **Operator action required**: after running, review any rules backfilled to the default school — they were previously global and are now silently owned by one tenant. Index creation is foreground (not `background: true`); on a large `sourcevalidationrules` collection this can briefly hold a write lock — plan for a maintenance window on large deployments.
  - **`021_encrypt_webhook_secrets`** — Encrypts existing plaintext `School.webhookSecret` values at rest with AES-256-GCM, and strips the plaintext `secret` field from any `WebhookRetry` documents that still carry it (#75). **Prerequisite**: set `WEBHOOK_SECRET_ENCRYPTION_KEY` (64-char hex) before running, or the migration no-ops (logs a skip) and secrets stay plaintext. Idempotent — values already prefixed `enc:` are skipped. Safe during a rolling deploy once the key is set.
  - **`022_create_reminder_logs`** — Creates the `reminderlogs` collection with a unique compound index on `{ schoolId, studentId, windowStart }` (cross-replica reminder idempotency) and a TTL index on `createdAt` (default 90-day retention, override with `REMINDER_LOG_TTL_SECONDS`). New collection — safe during a rolling deploy, no lock contention on existing data.
  - **`023_add_dispute_fields`** — Adds evidence/SLA/escalation tracking fields (`evidence`, `txReference`, `slaDeadline`, `slaBreachedAt`, `escalationLevel`, `escalatedAt`, `lastActivityAt`, `assignedTo`) to existing `disputes` documents, computing `slaDeadline` from each dispute's `createdAt` plus `DISPUTE_SLA_HOURS` (default 72h). Creates two non-unique indexes (`{ slaDeadline, status }`, `{ escalationLevel, status }`) for SLA/escalation queries. Safe during a rolling deploy; the `updateMany` backfill can take noticeable time on a large `disputes` collection since it uses an aggregation-pipeline update.
  - **`024_add_underpaid_reconciliation_field`** — Backfills an `underpaidReconciliation` sub-document (`status`, `appliedCredit`, `creditAppliedAt`, `creditAppliedBy`, `refundTxHash`, `refundInitiatedAt`, `refundCompletedAt`, `refundNote`) onto every existing `payments` document that lacks one. Data-only, no index changes. Safe during a rolling deploy; idempotent.
  - **`025_scope_payment_intent_memo_index`** — Fixes #1202: `paymentIntents.memo` had a global unique index, so two different schools producing the same memo hit a raw duplicate-key error. Drops the global unique `memo` index (if present) and creates a compound unique index on `{ schoolId, memo }` with `background: true`. Safe during a rolling deploy — the index build is backgrounded and does not hold a write lock, though it can take time to complete on a large `paymentintents` collection, during which duplicate-memo protection is temporarily index-less for that window.

  All seven migrations are already wired into `npm run migrate` (see `docs/migrations.md`); no code changes accompany this entry, only documentation.

### Fixed

- **tenantScope plugin threw TenantScopeError on every findById / findByIdAndUpdate (#1743)**: The `tenantScope` Mongoose plugin enforces `schoolId` on all queries against tenant-scoped models. Mongoose implements `Model.findById(id)` as `findOne({ _id: id })` and `findByIdAndUpdate(id, ...)` as `findOneAndUpdate({ _id: id }, ...)`, neither of which carries `schoolId`, so every `findById*` call on a tenant-scoped model (Payment, Student, Refund, Dispute, PaymentIntent, Receipt, EmailDelivery, PendingVerification, PaymentPlan, FeeAdjustmentRule, AuditLog, ReminderLog, FeeStructure, ReconciliationReport, StudentFeeHistory) threw `TenantScopeError` at runtime — breaking refund approval, intent-based submit, manual sync with intents, payment finalisation, reminder tracking, email delivery updates, receipt verification, and underpaid reconciliation. All 17 affected call sites across 10 source files replaced with `findOne({ _id, schoolId })` / `findOneAndUpdate({ _id, schoolId }, ...)`, threading `schoolId` through the refund service APIs (`approveRefund`, `rejectRefund`, `completeRefund` now accept `schoolId`). An ESLint `no-restricted-syntax` rule forbids `findById*` on all 15 tenant-scoped model variable names. A new test loads each tenant-scoped model against `mongodb-memory-server` and asserts `findById` throws `TENANT_SCOPE_MISSING` while `findOne({ _id, schoolId })` succeeds, including cross-tenant isolation.
- **TransactionManager retry semantics and replica-set baseline (#transactions)**: `withTransaction()` previously opened ONE session, called `session.startTransaction()` on it, and then ran its retry loop *inside* that session — every retry re-executed the operation against a transaction the server had already aborted, so retries could not succeed by construction and merely burned the backoff budget before surfacing `MAX_RETRIES_EXCEEDED`. `withTransaction()` now opens a fresh session per attempt and delegates per-attempt lifecycle semantics (start/commit/abort, `TransientTransactionError` callback retry, `UnknownTransactionCommitResult` commit retry) to the driver's `session.withTransaction()`, re-throwing the ORIGINAL error so driver labels survive for upstream callers. `isRetryableError()` was reduced to the driver error contract — `TransientTransactionError`/`UnknownTransactionCommitResult` labels plus numeric codes 112 (WriteConflict), 189 (PrimarySteppedDown), 261 (TooManyLogicalSessions) — deleting the message substring sweep that treated any error whose text contained 'Lock' or 'transaction' as transient and replayed it up to three times. Every bundled environment now runs MongoDB as an initiated single-node replica set ("rs0"), which multi-document transactions require: docker-compose.yml generates an intra-cluster keyfile at boot, runs mongod with `--replSet rs0`, and initiates via its healthcheck (verified live: transaction commits); both CI Mongo services do the same via their healthcheck; deploy/k8s/mongodb-statefulset.yaml was found to be STANDALONE (and localhost-bound) and now runs `--replSet rs0 --bind_ip_all` with a postStart `rs.initiate()` hook and a primary-only readiness probe. The requirement is documented in the module header and docs/architecture.md. Removed two orphaned test files (`tests/concurrentAllocation.test.js`, `tests/concurrent-payment-processor-queue.test.js`) that still imported `concurrentPaymentProcessor`, which was deleted in #1036 — they failed at require time and broke `npm test`.
- **Investigated duplicate sync bug (#731)**: Audited `syncAllPayments` in `paymentController.js` for the reported double `syncPaymentsForSchool` call and `ERR_HTTP_HEADERS_SENT` crash. Confirmed the code already calls `syncPaymentsForSchool` exactly once, sends a single response, and correctly passes `summary` to the audit log. No code change required.
- **Documented transaction-queue durability and fixed drainWorker orphan (#1053)**: Audited `backend/src/queue/` to verify that the primary transaction-submission queue (`transactionQueue.js`) is durable — every job is upserted to `PendingVerification` (MongoDB) before being handed to BullMQ, and `recoverPendingJobs()` re-enqueues any `pending`/`processing` documents on every restart. `docs/architecture.md` previously described the queue as "event-driven (BullMQ)" with no mention of the MongoDB outbox and startup recovery, which read as if Redis were the sole durability layer. It now distinguishes the three queues (transaction processing, transaction retry + DLQ, report generation) and documents the two-tier MongoDB + Redis durability model for each, the degraded MongoDB-only mode (when Redis is unreachable), the difference between the two queues' stalled-job recovery mechanisms, and the graceful-shutdown drain contract. The `transactionQueue.drainWorker()` was misusing `markDead()` for jobs interrupted by the drain timeout — those jobs were orphaned in `dead_letter` (which `recoverPendingJobs()` does NOT scan). Added `markInterrupted(txHash, reason)` which writes `status: 'pending'` with a `lastError` note so the next startup recovery sweep re-queues them. `tests/transactionQueueDurability.test.js` now contains a `restart-mid-queue — no transaction is silently dropped (#1053)` describe block (in-flight job whose Redis state was lost across a restart; doc stuck in `processing` from a dead worker; second-restart idempotency; end-to-end enqueue → crash → recover; drain-timeout markInterrupted sets `pending` not `dead_letter`) and a `graceful-shutdown interruption path (#1053)` describe block (markInterrupted writes `pending` and that doc is recoverable on the next boot).

### Added

- **Student Quota Enforcement (#680)**: Schools can now enforce per-school student registration limits via the `maxStudents` field. Quota is checked on both single student registration and bulk imports. Returns `403 STUDENT_QUOTA_EXCEEDED` when limit is reached.
- **Asset Validation in Payment Instructions (#682)**: `GET /api/payments/instructions/:studentId` now validates the optional `?asset=` query parameter against the school's accepted assets. Returns `400 ASSET_NOT_ACCEPTED` with a list of supported assets if the requested asset is not accepted.
- **Comprehensive Fee Adjustment Engine Tests (#681)**: Added extensive test coverage for `feeAdjustmentEngine` rule interactions, including sequential application of multiple rules, clamping of negative fees, and deterministic behavior verification.

### Changed

- **School Model**: Added `maxStudents` field (Number, default: 10000) to enforce student registration quotas per school.
- **Student Registration**: `POST /api/students` now checks school quota before creating a student.
- **Bulk Student Import**: `POST /api/students/bulk` now enforces quota with partial result support—rows exceeding the quota are marked as failed with `STUDENT_QUOTA_EXCEEDED` code.

### Fixed

- **Payment Instructions Clarity**: Parents requesting payment instructions for unsupported assets now receive a clear error message with a list of accepted assets, preventing confusion when payments are rejected.

### Documentation

- Added `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com) format.
- Updated `README.md` to link to `CHANGELOG.md`.

---

### Initial Release

- Decentralized school fee payment system built on Stellar blockchain
- Multi-school support with isolated wallets and records
- Automatic payment reconciliation via transaction memos
- Support for XLM and USDC payments
- Fee validation (exact, overpaid, underpaid detection)
- Payment history and audit trails
- Background polling for blockchain sync
- Retry mechanism for failed verifications
- RESTful API with comprehensive endpoints
- Next.js frontend for payment submission and dashboard
- MongoDB for persistent storage
- Docker Compose for containerized deployment
- Comprehensive test coverage with Jest

---

## Known Issues

- Rate limit persistence requires Redis configuration; without it, counters reset on server restart
- MongoDB replica set required for multi-document transactions (not supported on standalone instances)
- Stellar Horizon API rate limits constrain sync throughput during high-volume periods. This is now bounded and documented rather than open-ended: polling draws from a coordinated cross-school request budget spent in priority order, with measured maximum sync-delay figures and configuration guidance in [docs/horizon-rate-limits.md](docs/horizon-rate-limits.md). Operators running more than one replica must set `HORIZON_POLL_REPLICA_COUNT`, and should re-validate the published figures against their own Horizon instance before quoting them contractually.

---

## Migration Guide

### Upgrading to 1.0.0

#### Breaking Changes

None in this release.

#### Non-Breaking Changes

1. **Student Quota**: If you have schools with more than 10,000 students, update the `maxStudents` field in the School document to reflect your actual limit.
2. **Asset Validation**: Clients calling `GET /api/payments/instructions/:studentId?asset=USDC` will now receive a `400` error if USDC is not in the school's accepted assets. Update client code to handle this error gracefully.

#### Migration Steps

1. Update backend to latest version
2. Run database migrations (if any)
3. Restart backend services
4. Update frontend to handle new error codes: `STUDENT_QUOTA_EXCEEDED`, `ASSET_NOT_ACCEPTED`

---

## Contributing

Entries are generated from commit messages by [release-please](https://github.com/googleapis/release-please) (#1634), so PR titles / squash-merge commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: …` → **Added** (minor bump)
- `fix: …` → **Fixed** (patch bump)
- `feat!: …` or a `BREAKING CHANGE:` footer → **Breaking** (major bump)
- `docs:`, `chore:`, `test:`, `ci:`, `refactor:` → no release on their own

Hand-written detail (migrations, operator actions) may still be added to the release PR that release-please opens before it is merged.

---

## Release Process

See [docs/releasing.md](docs/releasing.md).

1. Merge PRs to `main` with conventional-commit titles.
2. release-please keeps a **release PR** open that bumps the version in every `package.json` and moves the pending notes into a new section of this file.
3. Merging the release PR tags `vX.Y.Z`, publishes a GitHub release with the generated notes, and the release workflow pushes Docker images tagged with the version as well as the commit SHA.

---

For more information, see [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
