# Security

## MFA enforcement (`REQUIRE_MFA`)

By default, TOTP MFA is opt-in per user (`User.mfaEnabled`) or per school (`School.mfaEnabled`) — a compromised admin password alone grants full access unless MFA was actively set up.

Setting `REQUIRE_MFA=true` closes this gap: on login, an admin with no MFA configured (neither their own nor their school's) receives a **restricted** session token instead of full access. `requireSchoolAuth` (`backend/src/middleware/auth.js`) rejects every request from a restricted token except the MFA enrollment endpoints (`POST /api/auth/mfa/user/setup`, `POST /api/auth/mfa/user/verify`) with `403 MFA_SETUP_REQUIRED`, so the frontend must complete enrollment before any protected endpoint becomes reachable. Once `POST /api/auth/mfa/user/verify` succeeds, the restriction is lifted for the current session immediately.

The login response includes `mfaSetupRequired: true` when this restricted session is issued, which the frontend uses to redirect to the MFA setup flow instead of the dashboard.

`REQUIRE_MFA` does not apply to the environment-configured super-admin break-glass account, which is not backed by the `User`/`School` MFA fields.

## MFA backup codes (#1774)

Backup codes are a full MFA bypass factor: whoever holds a valid unused code can complete login without the TOTP device. They are therefore treated as credentials, not as convenience strings.

### Entropy and format

- Each code is **10 characters drawn from a 32-symbol Crockford base32 alphabet** (`0-9`, `A-Z` minus `I`, `L`, `O`, `U`), giving **50 bits** of entropy per code — roughly 1.1 quadrillion possibilities.
- Codes are displayed and typed as `XXXXX-XXXXX`. The hyphen is cosmetic: input is upper-cased, stripped of hyphens/whitespace, and Crockford-normalized (`I`/`L` → `1`, `O` → `0`) before verification, so users can type codes case-insensitively and without the separator.
- Codes are generated with `crypto.randomBytes` and rejection sampling (no modulo bias) in `backend/src/controllers/mfaController.js`.

### Storage

- Codes are **never stored in plaintext**. Each code is hashed with **bcrypt (cost 10)** under its own per-code salt, so a precomputed table cannot cover multiple users or codes.
- A database dump therefore yields only bcrypt hashes. At 50 bits of entropy and bcrypt cost 10, exhaustive recovery of even a single code is infeasible; the previous scheme (32 bits, unsalted SHA-256) allowed every code of every user to be recovered in about a second per user.
- Verification iterates only the caller's **unused** codes and compares with `bcrypt.compare` (constant-time within bcrypt), never with `===` on hashes.

### Single-use under concurrency

Consumption is atomic. After a bcrypt match, the code is marked used with a conditional update:

```js
User.findOneAndUpdate(
  { _id: userId, 'mfaBackupCodes': { $elemMatch: { _id: codeId, used: false } } },
  { $set: { 'mfaBackupCodes.$[el].used': true, 'mfaBackupCodes.$[el].usedAt': new Date() } },
  { arrayFilters: [{ 'el._id': codeId, 'el.used': false }] }
)
```

If the update matches no document, another request consumed the code first and the attempt is rejected — two concurrent logins can never both succeed with the same code (fixes #1533). Used codes are retained (with `usedAt`) for audit until the next regeneration.

### Rate limiting

Backup-code verification is rate-limited per user and per IP (same limiter family as TOTP verification). Repeated failures are logged with hashed IPs per the log-redaction policy below, and a successful backup-code login is recorded in the audit log.

### Legacy codes and migration

Codes issued before #1774 (32-bit, unsalted SHA-256) are flagged `legacy: true` by the migration in `backend/src/migrations/`:

- Legacy codes **remain verifiable** so users are not locked out, but they are consumed on first use exactly like new codes.
- On the next successful login (password + TOTP), the user is prompted to regenerate backup codes; regenerating replaces the entire set with bcrypt-hashed 50-bit codes and invalidates all legacy entries.
- Operators should review `mfaBackupCodes.legacy` counts after deploying and follow up with users who have not regenerated. Once the count reaches zero, legacy verification can be removed in a follow-up release.

### Operator guidance

- Treat backup codes like passwords: never log them, never email them in plaintext after initial display, and show them exactly once at generation time.
- Regenerating codes invalidates the previous set immediately; support staff must not "re-issue" old codes.
- If a database dump is suspected, force regeneration for all users — the bcrypt hashes are not directly usable, but unused codes remain valid until rotated.

## Credential rotation

JWT secrets, the Stellar signing-key encryption key (`SIGNER_MASTER_KEY`), and the webhook
secret encryption key (`WEBHOOK_SECRET_ENCRYPTION_KEY`) have scripted rotation — see
`scripts/rotate-jwt-secret.js`, `scripts/rotate-signer-master-key.js`, and
`scripts/rotate-webhook-encryption-key.js`, and the "Key Rotation" section of
`docs/operator-runbooks.md` for when and how to run them.

### Webhook secret encryption key rotation

`backend/src/services/webhookSecretEncryption.js` encrypts every school's `webhookSecret` at
rest (AES-256-GCM) using a key derived from `WEBHOOK_SECRET_ENCRYPTION_KEY`. Rotating that key
without re-encrypting the stored secrets would make every existing secret undecryptable with
the new key, breaking outbound webhook signing for every school (#1380). Rotation is scripted
and supports a dual-key grace period so there is no cutover window where deliveries fail.

**Procedure:**

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` to the **current** key (the one already
   protecting stored secrets) and `WEBHOOK_SECRET_ENCRYPTION_KEY` to the **new** key, both in
   the deployment's secret store.
3. Run the migration script against the target database, first as a dry run:
   ```bash
   WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS=<current key> WEBHOOK_SECRET_ENCRYPTION_KEY=<new key> \
     node scripts/rotate-webhook-encryption-key.js
   ```
   Review the per-school report, then re-run with `--apply` to persist the re-encrypted
   values:
   ```bash
   WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS=<current key> WEBHOOK_SECRET_ENCRYPTION_KEY=<new key> \
     node scripts/rotate-webhook-encryption-key.js --apply
   ```
4. Redeploy the API and worker instances with both env vars set. While
   `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` is present, `decryptWebhookSecret()` transparently
   falls back to it whenever the new key fails an auth-tag check — this covers any secret the
   migration script hasn't reached yet and any instance still finishing a rolling deploy, so
   webhook deliveries are never interrupted mid-rotation.
5. Once the rollout is complete and step 3's `--apply` run reports zero failures, drop
   `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` from the deployment and redeploy again to close the
   grace period.
6. Verify a live webhook delivery signs correctly, then record the rotation time and operator
   in the incident log per the general rotation order in `docs/operator-runbooks.md`.

Skipping step 2 (or dropping the previous key before step 3 completes) reproduces the original
failure mode: any secret the script hasn't re-encrypted yet becomes unreadable, and signing
outbound webhooks for that school silently breaks.

## Signer master key secrets management (#1386)

`backend/src/utils/signerKeyManager.js` encrypts every school's Stellar signing secret key at
rest under a single master key. By default that master key is read from the
`SIGNER_MASTER_KEY` environment variable, which is the simplest option but has real exposure in
production: env vars are visible in `docker inspect` output and `/proc/<pid>/environ` on any node
running the container, in Kubernetes Secret manifests that may end up committed to version
control or stored unencrypted in `etcd`, and in CI logs that print the environment on failure.

To avoid holding the plaintext key in an env var, set `SIGNER_KEY_SOURCE` and call
`initializeMasterKey()` once at startup (already wired into `backend/src/app.js`'s boot sequence)
to resolve it from a real secrets manager instead:

| `SIGNER_KEY_SOURCE` | Behavior |
|---|---|
| `env` (default) | `getMasterKey()` reads `SIGNER_MASTER_KEY` directly — unchanged from before this feature. |
| `aws_secrets_manager` | Fetches the secret named by `SIGNER_MASTER_KEY_SECRET_ID` via `@aws-sdk/client-secrets-manager`, using `AWS_REGION` and the SDK's normal credential provider chain (IAM role, instance profile, etc. — no static AWS keys need to live in this app's config). |
| `http` | Fetches from any HTTP secrets endpoint at `SIGNER_MASTER_KEY_HTTP_URL` (e.g. a Vault or GCP Secret Manager sidecar/proxy), sending `SIGNER_MASTER_KEY_HTTP_TOKEN` as a bearer token when set. |

Either provider may return the key as a bare 64-character hex string or as JSON
(`{"SIGNER_MASTER_KEY": "<hex>"}` or `{"key": "<hex>"}`). The resolved key is cached in memory
only for the life of the process — it is never written back to `process.env` or to disk — and
`getMasterKey()` prefers it over `SIGNER_MASTER_KEY` whenever `initializeMasterKey()` has
populated it, so a misconfigured or unreachable provider fails loudly at boot (the process exits
non-zero, per `backend/src/app.js`) instead of silently falling back to an unset env var.

This does not change key **rotation** mechanics — `reEncryptSecretKey()` and
`scripts/rotate-signer-master-key.js` still apply; point `SIGNER_MASTER_KEY_OLD` /
`SIGNER_MASTER_KEY` (or the provider-backed equivalents) at the old and new key material as
described above.

A dedicated CI job (`scripts/scan-repo-secrets.js`, the `secret-scan-repo` job in
`.github/workflows/ci.yml`) scans every tracked file in the repository for real Stellar StrKey
secret keys (`S` + 55 base32 chars) so one can never be committed regardless of which
`SIGNER_KEY_SOURCE` a deployment uses.

## Content Security Policy (CSP)

StellarEduPay enforces a Content Security Policy on all HTTP responses to mitigate XSS attacks. The policy is applied at two layers: the Next.js frontend and the Express backend.

### Threat model

Without CSP, a successful XSS injection (e.g. a malicious student name rendered in the dashboard) can execute arbitrary JavaScript in the admin's browser, steal the JWT from `localStorage`, and exfiltrate school data. CSP prevents this by restricting which scripts, styles, and network destinations the browser will allow.

---

### Frontend CSP (`frontend/next.config.js`)

Applied to every HTML response via the Next.js `headers()` API:

```
Content-Security-Policy:
  default-src 'self';
  script-src  'self';
  style-src   'self';
  img-src     'self' data:;
  font-src    'self';
  connect-src 'self' https://horizon-testnet.stellar.org https://horizon.stellar.org;
  object-src  'none';
  frame-ancestors 'none';
  base-uri    'self';
  form-action 'self'
```

| Directive | Value | Rationale |
|-----------|-------|-----------|
| `default-src` | `'self'` | Deny all unlisted resource types by default |
| `script-src` | `'self'` | No inline scripts, no `eval`, no third-party JS |
| `style-src` | `'self'` | No inline styles, no third-party CSS |
| `img-src` | `'self' data:` | Allows inline SVG/base64 images used by the UI |
| `font-src` | `'self'` | Self-hosted fonts only |
| `connect-src` | `'self' https://horizon-testnet.stellar.org https://horizon.stellar.org` | Allows `fetch`/XHR to the backend API and both Stellar Horizon endpoints |
| `object-src` | `'none'` | Blocks Flash and other plugins |
| `frame-ancestors` | `'none'` | Prevents clickjacking (equivalent to `X-Frame-Options: DENY`) |
| `base-uri` | `'self'` | Prevents base-tag hijacking |
| `form-action` | `'self'` | Restricts form submissions to the same origin |

Additional security headers set alongside CSP:

| Header | Value |
|--------|-------|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

---

### Backend CSP (`backend/src/app.js`)

The Express backend serves only JSON API responses — directives for scripts, styles, and images are irrelevant. Helmet is configured with a minimal policy appropriate for an API:

```js
helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
})
```

`default-src 'none'` means the browser should load nothing from this origin as a document resource. `frame-ancestors 'none'` prevents the API responses from being embedded in frames.

---

### Verification

The CSP configuration is covered by `tests/csp.test.js`, which verifies:

- The frontend `next.config.js` exports a `headers()` function returning a catch-all entry with a `Content-Security-Policy` header.
- The frontend CSP includes `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, and the Stellar Horizon `connect-src` allowlist.
- The frontend CSP does **not** contain `'unsafe-inline'` or `'unsafe-eval'`.
- The backend `app.js` sets `defaultSrc: ["'none'"]` and `frameAncestors: ["'none'"]` and does **not** include `scriptSrc`, `styleSrc`, `imgSrc`, `'unsafe-inline'`, or `'unsafe-eval'`.

Run the tests with:

```bash
npm test -- tests/csp.test.js
```

---

### Adding new external origins

The CSP allow-list is defined in a **single source of truth**:

```
frontend/src/config/cspSources.js
```

Both `frontend/next.config.js` (runtime policy) and `tests/csp.test.js` (assertions) import from this module. Adding or removing an origin requires editing exactly one file — the change is automatically reflected in the deployed CSP header and in the test suite.

**To add a new external origin:**

1. Open `frontend/src/config/cspSources.js`.
2. Add the full origin (scheme + host, no trailing slash) to the appropriate array:
   - `CONNECT_SRC_ORIGINS` — fetch/XHR targets (APIs, WebSockets)
   - `STYLE_SRC_ORIGINS` — external stylesheets
   - `FONT_SRC_ORIGINS` — external font files
3. That's it. Run `npm test -- tests/csp.test.js` to confirm.

Do **not** add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`. If a third-party library requires inline scripts, use a nonce-based approach instead.

---

## SSRF Mitigations (Webhook Delivery)

All outbound webhook URLs pass through a multi-layer SSRF defence on every delivery attempt.

### Registration-time validation

`validateWebhookUrl(url)` is called when an endpoint is created or updated:

- Only `https://` scheme is accepted.
- Well-known internal hostnames (`localhost`, `*.local`, `*.internal`, `*.localhost`, `*.test`, `*.invalid`) are rejected without a DNS lookup.
- Bare IP literals are checked directly against the deny list.
- DNS is resolved and **all** returned addresses (A + AAAA) must be public.

### Send-time re-validation (DNS-rebinding defence)

Immediately before every HTTP delivery the hostname is re-resolved and every IP is re-checked. If the hostname now resolves to a private address (DNS rebinding attack), the delivery is aborted with error `SSRF_BLOCKED`.

### IP deny list

Both IPv4 and IPv6 are covered:

| Range | Reason |
|-------|--------|
| 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 | RFC 1918 private |
| 127.0.0.0/8 | Loopback |
| 169.254.0.0/16 | Link-local / AWS metadata |
| 100.64.0.0/10 | CGNAT (RFC 6598) |
| ::1 | IPv6 loopback |
| fe80::/10 | IPv6 link-local |
| fc00::/7 | IPv6 ULA |
| ::ffff:0:0/96 | IPv4-mapped (delegates to IPv4 check) |
| 64:ff9b::/96 | NAT64 prefix |

### Redirect blocking

The Axios instance used for delivery is configured with `maxRedirects: 0`. Any 3xx response is treated as a delivery failure with error code `SSRF_REDIRECT_BLOCKED` and is not followed.

### Response size cap

Response bodies are capped at 64 KB (`maxContentLength: 65536`). Requests that exceed this are aborted.

---

## Student PII Data Retention Policy

StellarEduPay implements automatic anonymization of student personally identifiable information (PII) to reduce breach exposure and align with data minimization principles from GDPR and similar privacy frameworks.

### What data is anonymized

Once the retention window expires for a soft-deleted student record, the following PII fields are cleared:

| Field | Cleared to |
|-------|-----------|
| `name` | `"Anonymized"` |
| `dateOfBirth` | `null` |
| `gender` | `null` |
| `parentName` | `null` |
| `contactNumber` | `null` |
| `parentPhone` | `null` |

Non-PII fields retained for audit and reconciliation purposes:

- `studentId`, `schoolId`, `class`, `academicYear` — for payment tracking
- `feeAmount`, `totalPaid`, `remainingBalance`, `fees` — for billing history
- Payment and transaction records — for regulatory compliance

### Configuration

**Environment variable:** `STUDENT_PII_RETENTION_DAYS` (default: 90)

- Specifies the number of days to retain PII after soft-delete before anonymization
- Default of 90 days (~3 months) balances operational need against breach exposure
- Set to `0` to disable anonymization (not recommended for production)

Example:

```bash
# Retain PII for 180 days (6 months) before anonymization
STUDENT_PII_RETENTION_DAYS=180
```

### Automation

The `piiAnonymizationScheduler` runs once daily on the leader node and:

1. Queries for soft-deleted students whose deletion date exceeds `STUDENT_PII_RETENTION_DAYS`
2. Skips records already anonymized (name="Anonymized" and all other PII fields null)
3. Bulk-updates matching records to clear sensitive fields
4. Logs the count of anonymized records for audit purposes

The scheduler is integrated into the leader-election system, ensuring it runs on exactly one instance in a clustered deployment.

### Regulatory compliance

This implementation supports:

- **GDPR Article 5** (data minimization) — data kept no longer than necessary
- **GDPR Article 17** (right to be forgotten) — PII erasure after the retention window
- **Local privacy regulations** — configurable retention period per deployment

Schools should configure `STUDENT_PII_RETENTION_DAYS` to match their legal obligations and operational needs.


---

## Log Redaction and PII Minimization

To comply with data minimization requirements (GDPR Article 5, storage limitation), the platform automatically redacts personal data from all application logs.

### What is redacted

#### PII Fields
All log entries at **info level and above** have the following fields masked:

| Field | Redaction Format |
|-------|-----------------|
| `email`, `parentEmail`, `contactEmail`, `loginId` | `u***@example.com` (first char + domain visible) |
| `phone`, `parentPhone` | `****7890` (last 4 digits visible) |
| `name` | `J*** S.` (first initial + last initial) |
| `studentId`, `memo`, `senderAddress`, `walletAddress` | `[REDACTED]` |

#### IP Addresses
- Raw IP addresses are **never logged**
- Instead, IPs are hashed using HMAC-SHA256 with a per-boot secret
- Same IP produces the same hash within a server session (for correlation/debugging)
- Hashes are not reversible and do not persist across server restarts

#### Query Strings
- Query strings are **stripped** from all logged URLs to prevent token/secret leakage
- Example: `/api/payments?token=abc123` → `/api/payments`

#### Secrets in Configuration
All environment variables matching the pattern `/(SECRET|PASSWORD|TOKEN|KEY|URI|HASH)$/i` are redacted in config dumps, with explicit exceptions for known non-secret keys like `SIGNER_KEY_SOURCE`, `EMAIL_PROVIDER`, etc.

Credentials embedded in URIs are also redacted:
- `mongodb://user:pass@host` → `mongodb://user:[REDACTED]@host`
- `redis://:pass@host` → `redis://:[REDACTED]@host`

### Implementation

Redaction is applied in three layers:

1. **Logger format** (`backend/src/utils/logger.js`): The `formatMessage()` function applies `redactPii()` to all log arguments at info level and above
2. **Request logger** (`backend/src/middleware/requestLogger.js`): IP addresses are hashed via `hashIp()`, URLs are stripped via `stripQueryString()`
3. **Auth middleware** (`backend/src/middleware/auth.js`): Failed auth attempts log hashed IPs instead of raw IPs

### Verification

Run the test suite to verify redaction:

```bash
npm test -- backend/tests/piiRedaction.test.js
```

The test verifies:
- Email addresses are masked in logs
- Phone numbers are masked in logs
- Names are masked in logs
- IP addresses are hashed (not logged in plaintext)
- Query strings are stripped from URLs
- Config dumps redact all secret-pattern environment variables

### Audit Log Exceptions

**Audit logs** (`audit_log` collection in MongoDB) are **not redacted** because they are the authoritative record for compliance and forensic investigation. However:
- Audit logs are access-controlled (admin-only via authenticated API)
- Audit logs respect the retention period configured in `AUDIT_LOG_RETENTION_DAYS`
- Audit logs are never written to file logs or stdout

### Log Retention

| Log Type | Retention | Location |
|----------|-----------|----------|
| File logs (combined/error) | `LOG_MAX_FILES` (default: 14 days) | `logs/combined-*.log`, `logs/error-*.log` |
| Aggregated logs | Per aggregator config | ELK, Datadog, CloudWatch, etc. |
| Audit logs | `AUDIT_LOG_RETENTION_DAYS` (default: 365 days) | MongoDB `audit_log` collection |

File logs are automatically rotated and deleted by `winston-daily-rotate-file`.

### Operator Responsibilities

1. **Configure log aggregators** to respect the platform's retention policy
2. **Restrict access** to log files and aggregation tools — logs still contain operational context that could be sensitive
3. **Do not disable redaction** — all PII redaction is mandatory for production use
4. **Monitor alerts** — admin alerts may contain masked PII; ensure alert channels are access-controlled

### Related Documentation

- [Data Privacy and Retention Policy](./privacy.md) — full data retention and data subject rights
- [Audit Service](../backend/src/services/auditService.js) — audit log implementation
- [PII Redaction Utilities](../backend/src/utils/piiRedaction.js) — redaction functions

---

## Audited Action Catalogue (#1554)

Every authenticated, state-changing request passes through `auditContext` middleware and calls `logAudit` in the handler. All entries land in the tamper-evident `audit_log` MongoDB collection.

An automated regression test (`tests/issue-1554-audit-context-coverage.test.js`) walks the Express router stack and fails if a non-GET authenticated route is missing `auditContext`.

### Student management

| Action | Trigger |
|--------|---------|
| `STUDENT_REGISTERED` | `POST /api/students` |
| `STUDENT_UPDATED` | `PATCH /api/students/:studentId` |
| `STUDENT_DELETED` | `DELETE /api/students/:studentId` |
| `STUDENT_RESTORED` | `POST /api/students/:studentId/restore` |
| `STUDENT_BULK_IMPORTED` | `POST /api/students/bulk` |
| `STUDENT_PAYMENT_RESET` | `POST /api/students/:studentId/reset-payment` |
| `STUDENT_RECONCILED` | `POST /api/students/:studentId/reconcile` |
| `STUDENT_REMINDER_RESUBSCRIBED` | `POST /api/students/:studentId/reminders/resubscribe` |
| `STUDENT_CREDIT_ADJUSTED` | `POST /api/students/:studentId/credit-adjustments` |

### Payments

| Action | Trigger |
|--------|---------|
| `PAYMENT_SYNC` | `POST /api/payments/sync` |
| `PAYMENT_FINALIZED` | `POST /api/payments/finalize` |
| `PAYMENT_STATUS_UPDATED` | `PATCH /api/payments/:txHash/status` |
| `PAYMENT_BULK_STATUS_UPDATED` | `PATCH /api/payments/bulk/status` |
| `PAYMENT_LOCKED` | `POST /api/payments/:paymentId/lock` |
| `PAYMENT_UNLOCKED` | `POST /api/payments/:paymentId/unlock` |
| `PAYMENT_DLQ_RETRIED` | `POST /api/payments/dlq/:id/retry` |
| `PAYMENT_SUSPICION_REVIEWED` | `PATCH /api/payments/:txHash/suspicion-review` |
| `PAYMENT_PLACEHOLDER_CORRECTED` | `PATCH /api/payments/:txHash/correct-placeholder` |
| `PAYMENT_REFUND_INITIATED` | `POST /api/payments/:txHash/refund` |
| `PAYMENT_REFUND_APPROVED` | `POST /api/payments/refunds/:refundId/approve` |
| `RECONCILIATION_REPORT_GENERATED` | `POST /api/payments/reconciliation/report` |

### Fee adjustments

| Action | Trigger |
|--------|---------|
| `FEE_ADJUSTMENT_CREATED` | `POST /api/fee-adjustments` |
| `FEE_ADJUSTMENT_UPDATED` | `PUT /api/fee-adjustments/:id` |
| `FEE_ADJUSTMENT_DELETED` | `DELETE /api/fee-adjustments/:id` |
| `FEE_ADJUSTMENT_DRY_RUN` | `POST /api/fee-adjustments/dry-run` |
| `FEE_ADJUSTMENT_APPLIED` | `POST /api/fee-adjustments/:id/apply` |

### Retry queue

| Action | Trigger |
|--------|---------|
| `RETRY_QUEUE_JOB_RETRIED` | `POST /api/retry-queue/jobs/:jobId/retry` |
| `RETRY_QUEUE_JOB_DELETED` | `DELETE /api/retry-queue/jobs/:jobId` |
| `RETRY_QUEUE_PAUSED` | `POST /api/retry-queue/pause` |
| `RETRY_QUEUE_RESUMED` | `POST /api/retry-queue/resume` |
| `RETRY_QUEUE_TRANSACTION_QUEUED` | `POST /api/retry-queue/queue` |

### Email suppression

| Action | Trigger |
|--------|---------|
| `EMAIL_SUPPRESSION_ADDED` | `POST /api/email/suppressions` |
| `EMAIL_SUPPRESSION_REMOVED` | `DELETE /api/email/suppressions/:email` |

### Authentication and MFA

| Action | Trigger |
|--------|---------|
| `PASSWORD_CHANGED` | `POST /api/auth/change-password` |
| `SESSION_REVOKED` | `DELETE /api/auth/sessions/:sessionId` |
| `MFA_ENABLED` | `POST /api/auth/mfa/setup` → `POST /api/auth/mfa/verify` |
| `MFA_DISABLED` | `POST /api/auth/mfa/disable` |
| `MFA_BACKUP_CODES_REGENERATED` | `POST /api/auth/mfa/backup-codes/regenerate` |
| `USER_MFA_SETUP_INITIATED` | `POST /api/auth/mfa/user/setup` |
| `USER_MFA_ENABLED` | `POST /api/auth/mfa/user/verify` |
| `USER_MFA_DISABLED` | `POST /api/auth/mfa/user/disable` |

### Public / intentionally un-audited endpoints

These endpoints either have no authenticated actor at call time or use their own documented verification mechanism:

| Endpoint | Reason |
|----------|--------|
| `POST /api/auth/login` | No actor yet; auth result logged by controller |
| `POST /api/auth/refresh` | Token rotation; no actor context |
| `POST /api/auth/logout` | Session teardown; no mutation |
| `POST /api/payments/intent` | Unauthenticated caller |
| `POST /api/payments/submit` | Unauthenticated caller |
| `POST /api/payments/verify` | Unauthenticated caller |
| `POST /api/email/webhooks/:provider` | Provider-authenticated (SNS/SendGrid signature) |
