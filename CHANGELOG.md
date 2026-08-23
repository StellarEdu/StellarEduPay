# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Syntax gate actually runs (`npm run check:syntax`)**: the script required the undeclared `glob` package and died with `MODULE_NOT_FOUND` on line 2 — CI paid for checkout + Node setup + three `npm ci` invocations and received no syntax checking, which is how a duplicate `const` declaration in `backend/src/routes/paymentRoutes.js` reached main. Rewritten as a pure-Node tool matching the `scan-example-secrets.js`/`validate-migrations.js` convention: recursive walk via `fs.readdirSync(dir, { recursive: true })` (no glob), `backend/src` parsed with `node --check` (the real runtime parser), and `frontend/src` parsed JSX-aware with the already-declared `@babel/core`. Coverage now spans both backend and frontend sources (245 files). Exit codes are deliberately distinct — `0` clean, `1` syntax error detected (output names file + line), `2` gate-internal failure (missing dependency/directory, zero files walked, unsupported Node) reported as `[check-syntax] GATE ERROR` — so a red CI step can no longer be mistaken for flakiness. The companion duplicate-import breakage in `paymentRoutes.js` is removed so the gate passes on this tree. Covered by `tests/checkSyntax.test.js`: fixture-based unit tests for both parsers and the exit-code contract, plus an integration run of the CLI against the live repository.
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
