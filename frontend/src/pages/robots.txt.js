/**
 * Dynamic robots.txt — generated server-side so it always references the
 * deployment's real origin (NEXT_PUBLIC_SITE_URL env var) rather than a
 * hard-coded placeholder domain.
 *
 * Admin routes are derived from the shared navigation config so the Disallow
 * list cannot drift from the actual route set.
 *
 * Issue #1582: replace the static public/robots.txt with this server-rendered
 * version to fix the hard-coded example.com domain and stale path entries.
 */

import { ADMIN_ROUTES } from '../config/navigation';

export default function RobotsTxt() {
  // Never rendered — getServerSideProps sends the raw text response.
  return null;
}

export function getServerSideProps({ req, res }) {
  // Derive the site origin at runtime from the environment variable or from
  // the incoming request headers (for local dev / Codespaces / staging).
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

  const disallowLines = ADMIN_ROUTES.map((route) => `Disallow: ${route}`).join('\n');

  const robots = [
    '# Robots.txt — generated at runtime by StellarEduPay',
    'User-agent: *',
    disallowLines,
    '',
    '# Allow public pages',
    'Allow: /',
    'Allow: /pay-fees',
    '',
    `# Sitemap location`,
    `Sitemap: ${siteUrl}/sitemap.xml`,
  ].join('\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  // Cache for 1 hour; CDNs / proxies may cache up to 24 hours.
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  res.write(robots);
  res.end();

  return { props: {} };
}
