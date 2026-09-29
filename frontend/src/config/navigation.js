/**
 * Canonical list of admin/authenticated routes.
 *
 * Referenced by:
 *  - pages/robots.txt.js  — populates the Disallow list so no admin page is crawlable
 *  - src/pages/_app.jsx   — sets X-Robots-Tag: noindex on server-rendered admin pages
 *  - tests/robots.test.js — asserts every entry is present in the Disallow list
 *
 * When a new admin page is added, add its path here and it will automatically
 * be disallowed from crawling. Public (non-admin) pages must NOT appear in
 * this list.
 */
const ADMIN_ROUTES = [
  '/dashboard',
  '/reports',
  '/fees',
  '/fee-adjustments',
  '/audit-logs',
  '/disputes',
  '/source-validation-rules',
  '/login',
  '/mfa-setup',
  '/set-password',
  '/reset-password',
  '/webhooks',
  '/analytics',
  '/refunds',
  '/unsubscribe',
];

module.exports = { ADMIN_ROUTES };
