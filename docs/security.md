# Security

## MFA enforcement (`REQUIRE_MFA`)

By default, TOTP MFA is opt-in per user (`User.mfaEnabled`) or per school (`School.mfaEnabled`) — a compromised admin password alone grants full access unless MFA was actively set up.

Setting `REQUIRE_MFA=true` closes this gap: on login, an admin with no MFA configured (neither their own nor their school's) receives a **restricted** session token instead of full access. `requireSchoolAuth` (`backend/src/middleware/auth.js`) rejects every request from a restricted token except the MFA enrollment endpoints (`POST /api/auth/mfa/user/setup`, `POST /api/auth/mfa/user/verify`) with `403 MFA_SETUP_REQUIRED`, so the frontend must complete enrollment before any protected endpoint becomes reachable. Once `POST /api/auth/mfa/user/verify` succeeds, the restriction is lifted for the current session immediately.

The login response includes `mfaSetupRequired: true` when this restricted session is issued, which the frontend uses to redirect to the MFA setup flow instead of the dashboard.

`REQUIRE_MFA` does not apply to the environment-configured super-admin break-glass account, which is not backed by the `User`/`School` MFA fields.

## Credential rotation

JWT secrets and the Stellar signing-key encryption key (`SIGNER_MASTER_KEY`) have scripted
rotation — see `scripts/rotate-jwt-secret.js` and `scripts/rotate-signer-master-key.js`, and
the "Key Rotation" section of `docs/operator-runbooks.md` for when and how to run them.

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
