# Security

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

If a new external service needs to be reachable from the frontend (e.g. a currency conversion API), add its origin to the `connect-src` directive in `frontend/next.config.js` and update the test in `tests/csp.test.js` accordingly.

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
