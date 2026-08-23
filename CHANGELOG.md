# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Closed the read-endpoint header-trust gap (`resolveSchool` treats `X-School-ID` as context, not authorisation)**: `GET /api/disputes`, `GET /api/disputes/:id`, `POST /api/disputes` and `GET /api/fee-adjustments` were reachable with nothing but a guessable `X-School-ID` header — dispute records join student identity to payment history and free-text narrative, and an anonymous dispute creation triggered outbound email + webhook fan-out. All dispute and fee-adjustment handlers now require a school-scoped JWT (`requireSchoolAuth()`); admin-only transitions keep `requireAdminAuth`. `resolveSchool` no longer falls through silently when a JWT is presented but expired/malformed (now `401 TOKEN_EXPIRED` / `401 INVALID_AUTH_TOKEN`), and unknown vs. deactivated schools return byte-identical 404s so resolution can no longer confirm which school identifiers are real (`SCHOOL_INACTIVE` 403 removed). Added `backend/src/config/publicEndpoints.js`, the canonical allowlist of intentionally-anonymous endpoints with a written threat model per entry, and `tests/allRoutesRequireAuth.test.js`, which walks every mounted route in the live Express stack on CI and fails if an unauthenticated request reaches any handler that is not allowlisted — new handlers cannot be published by omission of an auth middleware. `docs/threat-model.md` gained the "Identifiers Are Not Credentials" section; `SECURITY_STATUS_RECONCILIATION.md` updated to mark this formerly "still-open" gap fixed.
- **`GET /api/fees` now requires a school-scoped JWT**: fee structures were readable tenant data behind the guessable header; `includeDeleted=true` continues to additionally require super-admin.

### Fixed

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
