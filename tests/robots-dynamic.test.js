'use strict';

/**
 * Tests for issue #1582 — robots.txt and sitemap.xml should reference the
 * deployment's real origin and disallow all admin routes.
 *
 * Since the files are now generated server-side (pages/robots.txt.js and
 * pages/sitemap.xml.js), we test the generator logic directly rather than
 * reading static files from public/.
 */

const path = require('path');
const { ADMIN_ROUTES } = require('../frontend/src/config/navigation');

// ── robots.txt generator ──────────────────────────────────────────────────────

describe('ADMIN_ROUTES config', () => {
  it('exports a non-empty array of admin route paths', () => {
    expect(Array.isArray(ADMIN_ROUTES)).toBe(true);
    expect(ADMIN_ROUTES.length).toBeGreaterThan(0);
  });

  it('contains /dashboard', () => {
    expect(ADMIN_ROUTES).toContain('/dashboard');
  });

  it('contains /audit-logs', () => {
    expect(ADMIN_ROUTES).toContain('/audit-logs');
  });

  it('contains /reports', () => {
    expect(ADMIN_ROUTES).toContain('/reports');
  });

  it('contains /fees', () => {
    expect(ADMIN_ROUTES).toContain('/fees');
  });

  it('contains /fee-adjustments', () => {
    expect(ADMIN_ROUTES).toContain('/fee-adjustments');
  });

  it('contains /disputes', () => {
    expect(ADMIN_ROUTES).toContain('/disputes');
  });

  it('contains /login', () => {
    expect(ADMIN_ROUTES).toContain('/login');
  });

  it('does not include /pay-fees (public page)', () => {
    expect(ADMIN_ROUTES).not.toContain('/pay-fees');
  });

  it('does not include / (public home page)', () => {
    expect(ADMIN_ROUTES).not.toContain('/');
  });

  it('does not include the stale /test-currency entry', () => {
    expect(ADMIN_ROUTES).not.toContain('/test-currency');
  });

  it('every entry starts with /', () => {
    for (const route of ADMIN_ROUTES) {
      expect(route).toMatch(/^\//);
    }
  });
});

describe('robots.txt page generator', () => {
  let getServerSideProps;

  beforeAll(() => {
    // Require the page module directly — only the getServerSideProps export is tested.
    ({ getServerSideProps } = require('../frontend/src/pages/robots.txt'));
  });

  function mockContext(overrides = {}) {
    const written = [];
    const headers = {};
    return {
      req: {
        headers: {
          host: 'school.example.com',
          'x-forwarded-proto': 'https',
          ...overrides.reqHeaders,
        },
      },
      res: {
        setHeader(k, v) { headers[k] = v; },
        write(chunk) { written.push(chunk); },
        end() {},
        _getWritten: () => written.join(''),
        _getHeaders: () => headers,
      },
    };
  }

  it('returns an empty props object', async () => {
    const ctx = mockContext();
    const result = await getServerSideProps(ctx);
    expect(result).toEqual({ props: {} });
  });

  it('sets Content-Type to text/plain', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    expect(ctx.res._getHeaders()['Content-Type']).toMatch(/text\/plain/);
  });

  it('uses NEXT_PUBLIC_SITE_URL when set', async () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://stellaredupay.school.com';
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toContain('Sitemap: https://stellaredupay.school.com/sitemap.xml');
    process.env.NEXT_PUBLIC_SITE_URL = saved;
  });

  it('falls back to request headers when NEXT_PUBLIC_SITE_URL is unset', async () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toContain('Sitemap: https://school.example.com/sitemap.xml');
    if (saved !== undefined) process.env.NEXT_PUBLIC_SITE_URL = saved;
  });

  it('contains a Disallow line for every admin route', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    for (const route of ADMIN_ROUTES) {
      expect(body).toContain(`Disallow: ${route}`);
    }
  });

  it('allows / and /pay-fees', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toMatch(/Allow:\s*\//);
    expect(body).toMatch(/Allow:\s*\/pay-fees/);
  });

  it('does not include /test-currency', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).not.toContain('/test-currency');
  });
});

describe('sitemap.xml page generator', () => {
  let getServerSideProps;

  beforeAll(() => {
    ({ getServerSideProps } = require('../frontend/src/pages/sitemap.xml'));
  });

  function mockContext(overrides = {}) {
    const written = [];
    const headers = {};
    return {
      req: {
        headers: {
          host: 'school.example.com',
          'x-forwarded-proto': 'https',
          ...overrides.reqHeaders,
        },
      },
      res: {
        setHeader(k, v) { headers[k] = v; },
        write(chunk) { written.push(chunk); },
        end() {},
        _getWritten: () => written.join(''),
        _getHeaders: () => headers,
      },
    };
  }

  it('returns an empty props object', async () => {
    const ctx = mockContext();
    const result = await getServerSideProps(ctx);
    expect(result).toEqual({ props: {} });
  });

  it('sets Content-Type to application/xml', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    expect(ctx.res._getHeaders()['Content-Type']).toMatch(/application\/xml/);
  });

  it('uses NEXT_PUBLIC_SITE_URL when set', async () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://stellaredupay.school.com';
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toContain('<loc>https://stellaredupay.school.com/</loc>');
    if (saved !== undefined) process.env.NEXT_PUBLIC_SITE_URL = saved;
    else delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it('falls back to request headers when NEXT_PUBLIC_SITE_URL is unset', async () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toContain('<loc>https://school.example.com/</loc>');
    if (saved !== undefined) process.env.NEXT_PUBLIC_SITE_URL = saved;
  });

  it('includes /pay-fees', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toContain('/pay-fees');
  });

  it('uses today\'s date as lastmod', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).toContain(`<lastmod>${today}</lastmod>`);
  });

  it('does not include any admin routes', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    for (const route of ADMIN_ROUTES) {
      // /login is a special case — should not appear as a sitemap URL
      expect(body).not.toContain(`<loc>`  + route);
    }
  });

  it('does not include /dashboard, /audit-logs, /reports', async () => {
    const ctx = mockContext();
    await getServerSideProps(ctx);
    const body = ctx.res._getWritten();
    expect(body).not.toContain('/dashboard');
    expect(body).not.toContain('/audit-logs');
    expect(body).not.toContain('/reports');
  });
});
