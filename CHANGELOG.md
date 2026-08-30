# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.0.0] - 2026-05-29

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

### Upgrading to Unreleased

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

When submitting a pull request that modifies API routes, models, or controllers, please:

1. Add an entry to the `[Unreleased]` section of this `CHANGELOG.md`
2. Use the format: `- **Feature Name (#issue-number)**: Description`
3. Categorize under `Added`, `Changed`, `Fixed`, or `Deprecated`
4. Include any breaking changes in a separate section

CI will verify that `CHANGELOG.md` has been updated for PRs modifying:
- `backend/src/routes/**`
- `backend/src/models/**`
- `backend/src/controllers/**`

---

## Release Process

1. Update version in `package.json` following Semantic Versioning
2. Move `[Unreleased]` section to a new version section with date
3. Create a git tag: `git tag v1.2.3`
4. Push tag: `git push origin v1.2.3`
5. Create GitHub release with changelog excerpt

---

For more information, see [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
