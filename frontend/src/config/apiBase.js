/**
 * Single source of truth for the API base URL used by every client call
 * (axios, fetch, EventSource and download links) — #1578.
 *
 * Defaults to the relative, same-origin base "/api". The browser then talks
 * only to this app's own origin and the request reaches the backend either via
 * the Next.js rewrite in next.config.js (BACKEND_PROXY_TARGET) or via an
 * Ingress that routes /api to the backend on the same host. Keeping requests
 * first-party is what lets the HttpOnly SameSite=Strict auth cookies be sent.
 *
 * NEXT_PUBLIC_API_URL remains an explicit override for unusual cross-host
 * topologies (see docs/architecture.md "Frontend ↔ API topologies").
 */
const DEFAULT_API_BASE = "/api";

function normalise(base) {
  const trimmed = (base || "").trim();
  if (!trimmed) return DEFAULT_API_BASE;
  // Strip trailing slashes so `${API_BASE_URL}/path` never yields "//path".
  return trimmed.replace(/\/+$/, "") || DEFAULT_API_BASE;
}

export const API_BASE_URL = normalise(process.env.NEXT_PUBLIC_API_URL);

/**
 * Build a full API URL for non-axios callers (fetch, EventSource, <a href>).
 *
 * @param {string} path   - path relative to the API base, e.g. "/auth/me"
 * @param {object} [query] - optional query params (undefined/null are skipped)
 * @returns {string}
 */
export function apiUrl(path = "", query) {
  const suffix = path && !path.startsWith("/") ? `/${path}` : path;
  let url = `${API_BASE_URL}${suffix}`;
  if (query) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) params.append(k, String(v));
    });
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}
