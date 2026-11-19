/* StellarEduPay service worker — issue #1831.
 *
 * Scope: the public parent payment pages (/pay-fees and /pay/<studentId>).
 * Goal: once a parent has loaded the page on a good connection, the payment
 * instructions and QR code stay viewable if the signal drops.
 *
 * Strategies:
 *   - Navigations to /pay-fees and /pay/* : network-first, falling back to the
 *     last cached copy of the page.
 *   - /_next/static/* (content-hashed, immutable) : cache-first.
 *   - GET /api/payments/instructions/* and GET /api/public-config :
 *     network-first, falling back to the last successful response.
 *   - Everything else, and every non-GET request, goes to the network untouched.
 *
 * Bump CACHE_VERSION to invalidate all cached data after a breaking release.
 */

const CACHE_VERSION = 'v1';
const PAGES_CACHE = `sep-pages-${CACHE_VERSION}`;
const ASSETS_CACHE = `sep-assets-${CACHE_VERSION}`;
const DATA_CACHE = `sep-data-${CACHE_VERSION}`;
const KNOWN_CACHES = [PAGES_CACHE, ASSETS_CACHE, DATA_CACHE];

const PAGE_PATHS = ['/pay-fees'];
const PAGE_PREFIXES = ['/pay/'];
const DATA_PATHS = ['/api/public-config'];
const DATA_PREFIXES = ['/api/payments/instructions/'];

self.addEventListener('install', (event) => {
  // Activate the new worker as soon as it is installed; the pages it serves
  // are all read-only, so there is no in-flight state to protect.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('sep-') && !KNOWN_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isPagePath(pathname) {
  return PAGE_PATHS.includes(pathname) || PAGE_PREFIXES.some((p) => pathname.startsWith(p));
}

function isDataPath(pathname) {
  return DATA_PATHS.includes(pathname) || DATA_PREFIXES.some((p) => pathname.startsWith(p));
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate' && isPagePath(url.pathname)) {
    event.respondWith(networkFirst(request, PAGES_CACHE));
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, ASSETS_CACHE));
    return;
  }

  if (isDataPath(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
  }
});
