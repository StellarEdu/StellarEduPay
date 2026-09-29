/** @type {import('next').NextConfig} */

// External-origin allow-lists are defined in a single shared module so that
// both this file (runtime policy) and tests/csp.test.js (assertions) stay in
// sync automatically. To add a new origin, edit only cspSources.js.
const {
  CONNECT_SRC_ORIGINS,
  STYLE_SRC_ORIGINS,
  FONT_SRC_ORIGINS,
} = require('./src/config/cspSources');

const isDev = process.env.NODE_ENV !== 'production';

// Origin of the backend API (scheme://host:port), derived from the public API
// URL so the CSP connect-src can permit cross-origin XHR to it. Falls back to
// the local dev backend.
// Issue #1583: NEXT_PUBLIC_API_URL may be empty (relative path) when running
// behind the Next.js /api/* proxy rewrite, in which case we omit it from the
// CSP connect-src (same-origin requests don't need an explicit allow).
const API_ORIGIN = (() => {
  const raw = process.env.NEXT_PUBLIC_API_URL || '';
  if (!raw || raw.startsWith('/')) return null; // relative — same origin, no CSP entry needed
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
})();

// Content-Security-Policy for the Next.js frontend.
//
// Why here and not in the Express backend?
// The backend serves only JSON API responses — CSP directives like scriptSrc
// and styleSrc are meaningless for JSON. The frontend (Next.js) renders HTML
// and is the correct place to enforce a browser-facing CSP.
//
// CSP posture (issue #396): scripts are locked down — script-src is strict 'self'
// in production (the meaningful XSS control). React/Next.js style the DOM with
// inline styles (dynamic style props + Next's CSS injection), so style-src permits
// 'unsafe-inline' — a low-risk allowance that is the industry-standard Next.js CSP
// when per-request nonces aren't in use. Dev additionally needs script-src
// 'unsafe-eval' for HMR; production never grants it.
const scriptSrc = isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'";

const CSP = [
  "default-src 'self'",
  scriptSrc,
  `style-src 'self' 'unsafe-inline' ${STYLE_SRC_ORIGINS.join(' ')}`,
  "img-src 'self' data:",
  `font-src 'self' ${FONT_SRC_ORIGINS.join(' ')} data:`,
  // Allow fetch/XHR to the backend API and Stellar Horizon (testnet + mainnet).
  // The backend API origin is included so the browser can reach it cross-origin
  // in split-port deployments (e.g. localhost:3000 UI → localhost:5000 API).
  // When API_ORIGIN is null (relative URL, same-origin), omit it from the CSP.
  `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''} ${CONNECT_SRC_ORIGINS.join(' ')}`,
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

// Server-side origin of the backend, used by the same-origin proxy (rewrites)
// below. Lets the browser call the API same-origin (/api/*) so cookies stay
// first-party — essential in split-host setups like GitHub Codespaces.
// Note: rewrites are resolved at `next build`, so in Docker this must be passed
// as a build arg (see frontend/Dockerfile and docker-compose.yml).
const BACKEND_ORIGIN = process.env.BACKEND_PROXY_TARGET || 'http://localhost:5000';

const nextConfig = {
  // Produces a self-contained build in .next/standalone — required for Docker
  output: 'standalone',
  // Same-origin API proxy: browser → /api/* (this origin) → backend. Keeps
  // requests first-party so HttpOnly SameSite=Strict auth cookies are sent.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_ORIGIN}/api/:path*` },
    ];
  },
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
