# StellarEduPay Threat Model

This threat model uses STRIDE to document major risks for a multi-tenant, money-moving Stellar payment system.

## Scope

In scope: authentication, tenant isolation, payment creation, transaction submission, reconciliation, webhook ingestion, queue processing, operator actions, key rotation, database integrity, and audit logs.

## Assets

- User identities and sessions.
- Tenant configuration and payment policies.
- Payment records, transaction hashes, and audit events.
- Stellar signing keys or delegated signing credentials.
- Webhook secrets and provider credentials.
- Database backups.
- Operator accounts and deployment credentials.

## STRIDE Analysis

| Category | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| Spoofing | Stolen session or API token | Unauthorized payment requests | Short-lived sessions, secure cookies, token rotation, session revocation |
| Spoofing | Forged webhook callback | False payment confirmation | Verify signatures, timestamp tolerance, replay protection |
| Tampering | Client changes amount, asset, or destination | Funds sent incorrectly | Server-side validation, tenant policy checks, immutable audit event |
| Tampering | Queue payload replayed | Duplicate payment execution | Idempotency keys and worker-side revalidation |
| Repudiation | Operator changes payment state without trace | No accountability | Immutable audit events with operator identity and reason |
| Information Disclosure | Tenant data leaks across accounts | Privacy and compliance issue | Tenant-scoped queries and authorization tests |
| Information Disclosure | Secrets appear in logs | Credential compromise | Structured redaction, secret scanning, log access controls |
| Denial of Service | Redis or queue unavailable | Payments stuck or delayed | Write pause, retry queues, recovery runbooks |
| Denial of Service | Horizon unavailable | Unknown transaction status | Submission pause and reconciliation retry |
| Elevation of Privilege | User reaches admin actions | Unauthorized recovery or config changes | Role-based access control and admin audit log |

## Money-Moving Controls

- Every payment request must have a tenant, authenticated actor, idempotency key, amount, asset, destination, and purpose.
- Workers must reload canonical payment state before submitting a transaction.
- Reconciliation must tolerate duplicate callbacks and delayed ledger confirmation.
- Manual recovery must require an operator reason and produce an audit event.
- Refund or emergency actions must be reviewed by two operators when production funds are involved.

## Webhook Controls

Verify provider signatures before parsing business fields, reject callbacks outside the allowed timestamp window, store raw and normalized event IDs for deduplication, and never trust webhook state alone when on-chain state can be checked.

## Tenant Isolation Controls

Every query for user-visible payment data must include tenant scope. Tenant IDs must come from authenticated server-side context, not request body alone. Tests should cover cross-tenant reads, writes, webhook events, and SSE subscriptions.

## Identifiers Are Not Credentials

`X-School-ID` and `X-School-Slug` are **identifiers**, not credentials. They select *which* tenant a request refers to; they never prove *who* is asking.

- School IDs follow the `SCH-3F2A` format — four hex characters (65,536-value space), enumerable in seconds. Slugs (`lincoln-high`) are guessable without enumeration.
- Neither value is treated as a secret anywhere else in the system: the frontend keeps `schoolId` in `localStorage`, sends it on every request, and slugs appear in URLs and operator documentation.
- Failure responses are deliberately indistinguishable for unknown and deactivated schools so resolution cannot be used as an identifier-validity oracle.
- A request that *presents* a JWT is held to it: `resolveSchool` returns `401 TOKEN_EXPIRED` / `401 INVALID_AUTH_TOKEN` for broken credentials rather than treating them as anonymous, and rejects cross-tenant tokens with `403 TENANT_MISMATCH`.

Consequences:

1. **Authentication is the default.** Every route that mounts `resolveSchool` must also mount an authentication middleware (`requireAdminAuth` or `requireSchoolAuth`). The only exceptions live on the explicit allowlist in [`backend/src/config/publicEndpoints.js`](../backend/src/config/publicEndpoints.js), each with its own written threat model. `tests/allRoutesRequireAuth.test.js` walks every mounted route on every CI run and fails if an unauthenticated request can reach a handler that is not allowlisted — a new handler cannot silently go public by omission.
2. **No anonymous dispute or fee-rule surface.** Disputes join student identity to payment history and free-text narrative; fee-adjustment rules disclose discount/scholarship policy. Reading, listing, or creating either requires a school-scoped JWT. If a parent-facing anonymous dispute form becomes a product requirement, it must be a separately mounted public route with per-school + per-IP rate limiting, a captcha or signed-link requirement, and no outbound email/webhook fan-out from unauthenticated callers — not an unauthenticated hole inside an otherwise-protected router.
3. **Known accepted residual risk.** The parent payment flow (`POST /api/payments/intent|submit|verify`, `GET /api/payments/instructions/:studentId`, tx-hash-keyed status/receipt/refund lookups) is anonymous by design because parents have no accounts; each entry's enumerability and mitigations are documented on the allowlist. `GET /api/payments/instructions/:studentId` remains the weakest point — student IDs are low-entropy and the response discloses fee amounts — and is flagged there for future captcha/signed-link hardening if abuse is observed.
