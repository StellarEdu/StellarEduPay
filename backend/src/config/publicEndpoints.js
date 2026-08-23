'use strict';

/**
 * publicEndpoints.js — the canonical allowlist of endpoints that do NOT require
 * a JWT authentication middleware.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The default posture of this API is "every mounted route requires an
 * authentication middleware" (requireAdminAuth / requireSchoolAuth). A route
 * without one is a bug unless it appears here with a written threat model.
 *
 * tests/route-auth-coverage.test.js walks the live Express router stack and
 * asserts that every mounted route either contains authentication middleware
 * (behaviourally: an unauthenticated request gets 401/403) or matches an entry
 * in PUBLIC_ENDPOINTS below. Adding a handler without auth therefore fails CI
 * until the route is fixed or explicitly allowlisted here.
 *
 * RULES FOR ADDING AN ENTRY
 * -------------------------
 *  1. It must genuinely receive no JWT-based authorisation today.
 *  2. It needs `reason` (why public at all) AND `residualRisk` (what an
 *     anonymous caller can do to us) filled in honestly.
 *  3. Anything that exposes tenant data keyed by LOW-ENTROPY identifiers
 *     (school IDs like SCH-3F2A, student IDs like STU001, slugs like
 *     "lincoln-high") must say so in residualRisk — those identifiers are
 *     NOT credentials and are enumerable. High-entropy capability secrets
 *     (256-bit Stellar tx hashes, signed unsubscribe tokens) are acceptable
 *     access control ONLY when the resource has no enumeration oracle.
 *  4. Endpoints protected by non-JWT mechanisms (HMAC signatures, shared
 *     secrets, bearer tokens) belong here too — they are "public" from the
 *     JWT system's point of view — but must name their actual protection.
 *
 * BACKGROUND: see docs/threat-model.md ("Identifiers are not credentials") and
 * SECURITY_STATUS_RECONCILIATION.md.
 */

const PUBLIC_ENDPOINTS = [
  // ── System health & observability ──────────────────────────────────────────
  {
    method: 'GET',
    path: '/health',
    reason: 'Container/orchestrator liveness probe. Returns aggregate status only.',
    residualRisk: 'Reveals subsystem health (ok/degraded/unhealthy) — operational metadata, no tenant data.',
  },
  {
    method: 'GET',
    path: '/health/live',
    reason: 'Kubernetes liveness probe.',
    residualRisk: 'None beyond confirming the process is up.',
  },
  {
    method: 'GET',
    path: '/health/ready',
    reason: 'Kubernetes readiness probe.',
    residualRisk: 'Same as /health.',
  },
  {
    method: 'GET',
    path: '/metrics',
    reason: 'Prometheus scrape endpoint.',
    protection: 'METRICS_BEARER_TOKEN bearer auth inside middleware/metricsAuth.js — fail-closed (401 without token, 500/disabled when unset, fatal startup exit in production). Separate 60/min rate limit.',
    residualRisk: 'Without a configured token the endpoint is disabled, never open.',
  },
  {
    method: 'GET',
    path: '/api/docs.json',
    reason: 'Machine-readable OpenAPI spec for API consumers and generated clients.',
    residualRisk: 'Discloses API surface shape (paths/schemas), not data.',
  },
  {
    method: 'GET',
    path: '/api/docs',
    reason: 'Swagger UI (development convenience).',
    protection: 'Not mounted when NODE_ENV=production (see app.js).',
    residualRisk: 'Same surface disclosure as /api/docs.json.',
  },
  {
    method: 'GET',
    path: '/api/docs/*',
    reason: 'Swagger UI static assets (swagger-ui.css, index.html, …).',
    protection: 'Dev-only mount; see /api/docs.',
    residualRisk: 'Static asset bytes only.',
  },

  // ── Auth credential lifecycle ───────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/auth/login',
    reason: 'Credential issuance — callers cannot present a JWT they do not yet have.',
    protection: 'IP rate limit (10/15min) plus per-account lockout in the controller.',
    residualRisk: 'Online password guessing; mitigated by lockout and alerting.',
  },
  {
    method: 'POST',
    path: '/api/auth/refresh',
    reason: 'Access-token renewal from the HttpOnly refresh cookie.',
    protection: 'Refresh cookie integrity + rotation; invalid cookies rejected.',
    residualRisk: 'Cookie theft implies session theft regardless of this route.',
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    reason: 'Session invalidation must always be reachable, including from a broken session.',
    residualRisk: 'Unauthenticated logout is idempotent revocation — no data disclosed.',
  },

  // ── School directory (pre-auth discovery) ───────────────────────────────────
  {
    method: 'GET',
    path: '/api/schools',
    reason: 'Directory read used by pre-auth flows (school selection during onboarding/login).',
    residualRisk: 'Confirms which schools exist and their names/slugs. Slugs appear in operator URLs anyway, so this discloses no secret; it MUST stay limited to directory metadata (no wallets, no settings).',
  },
  {
    method: 'GET',
    path: '/api/schools/:schoolId',
    reason: 'Single-school directory read for the same pre-auth flows.',
    residualRisk: 'Same as GET /api/schools. Note: school IDs (e.g. SCH-3F2A) and slugs are IDENTIFIERS, not credentials — treat everything behind them as untrusted context, never as authorisation.',
  },

  // ── Public student info ─────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/students/public/:studentId',
    reason: 'Deliberately limited lookup (name, class, feePaid) so parents can verify a student before paying.',
    residualRisk: 'Student IDs (STU001-style) are low-entropy and enumerable within a known school; response leaks student existence + name/class/payment flag per guess. Accepted product trade-off for the parent journey; scoped projection only — never widen the returned fields.',
  },

  // ── Reminder unsubscribe (capability URL) ───────────────────────────────────
  {
    method: 'GET',
    path: '/api/reminders/unsubscribe',
    reason: 'One-click unsubscribe from emailed links; recipients have no accounts.',
    protection: 'Per-school signed token carried in the query string; requests without a valid token are rejected inside the controller.',
    residualRisk: 'Token holder can unsubscribe that school’s reminders (availability nuisance, not disclosure).',
  },

  // ── Inbound provider webhooks (non-JWT cryptographic protection) ────────────
  {
    method: 'POST',
    path: '/api/email/webhooks/:provider',
    reason: 'Bounce/complaint callbacks from email providers, which cannot hold our JWTs.',
    protection: 'EMAIL_WEBHOOK_SECRET shared-secret validation inside the controller.',
    residualRisk: 'Secret compromise would let a caller poison suppression state.',
  },
  {
    method: 'POST',
    path: '/api/email-provider-webhook/callback',
    reason: 'Delivery-event callbacks from the email delivery provider.',
    protection: 'HMAC signature verification via middleware/validateInboundWebhook.js (EMAIL_PROVIDER_WEBHOOK_SECRET); unsigned payloads rejected before parsing business fields.',
    residualRisk: 'Signature-key compromise; replay window bounded by timestamp tolerance.',
  },

  // ── Parent payment flow ─────────────────────────────────────────────────────
  // Parents pay from a browser without accounts. These endpoints are the
  // designed anonymous journey; each one either creates nothing sensitive,
  // requires a real on-chain fact, or is gated by a high-entropy capability.
  {
    method: 'POST',
    path: '/api/payments/intent',
    reason: 'Parent flow step: register payment intent (amount/asset) before sending funds.',
    residualRisk: 'Anonymous DB writes (intent records) — bounded by global rate limit + Idempotency-Key handling; intents reference students but disclose nothing on read.',
  },
  {
    method: 'POST',
    path: '/api/payments/submit',
    reason: 'Parent flow step: submit the tx hash of a payment they just made so it can be matched.',
    residualRisk: 'Spam submissions are validated against the real Horizon ledger; junk tx hashes are rejected without side effects. Global rate limit bounds request cost.',
  },
  {
    method: 'POST',
    path: '/api/payments/verify',
    reason: 'Parent flow step: verify a transaction hash against the blockchain and record the payment.',
    protection: 'Dedicated VERIFY_RATE_LIMIT limiter (default 10/min/IP) + idempotency middleware.',
    residualRisk: 'Only transactions that genuinely exist on-chain can produce a record; abuse cost is bounded by the strict limiter and real Stellar fees.',
  },
  {
    method: 'GET',
    path: '/api/payments/verify/:txHash',
    reason: '"Has my payment confirmed?" status check for parents right after paying.',
    residualRisk: 'Keyed by the full 256-bit transaction hash — unguessable capability, no enumeration oracle (unknown hashes 404 identically).',
  },
  {
    method: 'GET',
    path: '/api/payments/verify/:receiptId',
    reason: 'Receipt-status variant of the same check (shadowed at runtime by /verify/:txHash).',
    residualRisk: 'Same capability-secret reasoning as /verify/:txHash.',
  },
  {
    method: 'GET',
    path: '/api/payments/instructions/:studentId',
    reason: 'Core parent journey: wallet address + memo + accepted assets needed to actually pay.',
    residualRisk: 'KNOWN GAP (accepted): student IDs are low-entropy, so fee amount/category data is enumerable per guessed ID within a school. Discloses wallet address (public on-chain data), accepted assets, limits, and the student’s fee total. Mitigation candidates if abused: captcha, per-IP+per-school limiter, or signed payment links. Do NOT add fields here.',
  },
  {
    method: 'GET',
    path: '/api/payments/receipt/:txHash',
    reason: 'Receipt download link shared with parents after payment.',
    residualRisk: 'Keyed by 256-bit tx hash — unguessable capability; no enumeration oracle.',
  },
  {
    method: 'GET',
    path: '/api/payments/:txHash/refunds',
    reason: 'Refund status lookup tied to a specific on-chain transaction a parent references.',
    residualRisk: '256-bit tx-hash capability; unknown hashes indistinguishable from missing refunds.',
  },
];

/**
 * Match a concrete request against the allowlist.
 *
 * @param {string} method - HTTP method, case-insensitive
 * @param {string} path   - concrete mounted path, e.g. "/api/payments/verify/abc"
 * @returns {boolean} true when the path is on the public allowlist
 */
function isPublicEndpoint(method, path) {
  const normalizedMethod = String(method || '').toUpperCase();
  const segments = String(path || '').split('/').filter(Boolean);

  return PUBLIC_ENDPOINTS.some((entry) => {
    if (entry.method !== '*' && entry.method.toUpperCase() !== normalizedMethod) {
      return false;
    }
    // "…/*" entry matches the prefix itself plus anything beneath it.
    if (entry.path.endsWith('/*')) {
      const base = entry.path.slice(0, -2).split('/').filter(Boolean);
      if (segments.length < base.length) return false;
      return matchSegments(base, segments.slice(0, base.length));
    }
    const pattern = entry.path.split('/').filter(Boolean);
    if (pattern.length !== segments.length) return false;
    return matchSegments(pattern, segments);
  });
}

function matchSegments(pattern, segments) {
  return pattern.every((seg, i) =>
    seg.startsWith(':') ? segments[i].length > 0 : seg === segments[i]
  );
}

module.exports = { PUBLIC_ENDPOINTS, isPublicEndpoint };
