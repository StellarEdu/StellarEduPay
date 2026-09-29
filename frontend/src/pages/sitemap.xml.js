/**
 * Dynamic sitemap.xml — generated server-side so it always references the
 * deployment's real origin (NEXT_PUBLIC_SITE_URL env var).
 *
 * Issue #1582: replace the static public/sitemap.xml with this server-rendered
 * version to fix the hard-coded example.com domain and static lastmod date.
 *
 * Only public-facing pages are listed. Admin/authenticated pages are excluded
 * (they are disallowed in robots.txt and have X-Robots-Tag: noindex anyway).
 */

export default function SitemapXml() {
  // Never rendered — getServerSideProps sends the raw XML response.
  return null;
}

export function getServerSideProps({ req, res }) {
  // Derive the site origin at runtime from the environment variable or from
  // the incoming request headers (for local dev / Codespaces / staging).
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

  // Use today's date as lastmod so search engines know the content is fresh.
  const today = new Date().toISOString().slice(0, 10);

  // Public pages that should be indexed. Add new public pages here.
  const publicPages = [
    { path: '/', changefreq: 'monthly', priority: '1.0' },
    { path: '/pay-fees', changefreq: 'monthly', priority: '0.8' },
  ];

  const urlEntries = publicPages
    .map(
      ({ path, changefreq, priority }) => `  <url>
    <loc>${siteUrl}${path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
    )
    .join('\n');

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  // Cache for 1 hour; CDNs / proxies may cache up to 24 hours.
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  res.write(sitemap);
  res.end();

  return { props: {} };
}
