#!/usr/bin/env node
'use strict';

/**
 * Generate the committed API route manifest used by the frontend contract
 * tests.  This intentionally inspects the Express app rather than maintaining
 * a second list of routes.  Express 4 exposes `_router`; Express 5 exposes
 * `router`, so both are supported while retaining the requested `_router`
 * traversal semantics.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JEST_WORKER_ID = process.env.JEST_WORKER_ID || 'route-manifest';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-manifest-only-secret';
process.env.RECEIPT_SIGNATURE_SECRET = process.env.RECEIPT_SIGNATURE_SECRET || 'route-manifest-only-receipt-secret';
process.env.SIGNER_MASTER_KEY = process.env.SIGNER_MASTER_KEY || 'route-manifest-only-signer-key-32-bytes';
process.env.SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/route_manifest';
process.env.REDIS_HOST = '';
process.env.STELLAR_HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'http://127.0.0.1:0';
process.env.SWAGGER_ENABLED = 'false';

const app = require(path.join(root, 'backend', 'src', 'app'));
const manifest = [];

function layerPath(layer) {
  if (typeof layer.path === 'string') return layer.path;
  if (layer.regexp && layer.regexp.fast_slash) return '';
  // Express 4 stores mounted prefixes in regexp.source. Express 5 stores the
  // original path in `matchers` only, so use the best stable representation.
  const source = layer.regexp && layer.regexp.source;
  if (!source) return '';
  const match = source.match(/^\\\/(.*?)\\\/?\(\?:\\\/\|\$\)/);
  if (match) return `/${match[1].replace(/\\\//g, '/')}`;
  return '';
}

function middlewareName(fn) {
  if (!fn) return 'anonymous';
  return fn.name || 'anonymous';
}

function normalizePath(value) {
  const pathValue = (`/${value || ''}`).replace(/\/+/g, '/');
  if (pathValue === '/') return '/';
  return pathValue.replace(/\/$/, '');
}

function walk(stack, prefix = '', inherited = []) {
  for (const layer of stack || []) {
    const current = layerPath(layer);
    const fullPrefix = `${prefix}${current}`.replace(/\/+$/, '') || '';
    const middleware = [...inherited];
    if (layer.name && layer.name !== 'router' && layer.name !== 'bound dispatch') middleware.push(layer.name);

    if (layer.route) {
      const routePath = `${fullPrefix}${layer.route.path}`.replace(/\/+/g, '/');
      const routeMiddleware = [...middleware, ...(layer.route.stack || []).map((entry) => middlewareName(entry.handle))];
      for (const method of Object.keys(layer.route.methods || {}).filter((name) => layer.route.methods[name])) {
        manifest.push({
          method: method.toUpperCase(),
          path: normalizePath(routePath),
          middleware: [...new Set(routeMiddleware)].sort(),
        });
      }
      continue;
    }
    if (layer.handle && (layer.handle.stack || layer.handle._router?.stack)) {
      walk(layer.handle.stack || layer.handle._router.stack, fullPrefix, middleware);
    }
  }
}

walk(app._router?.stack || app.router?.stack || []);
const normalized = [...new Map(manifest.map((route) => [`${route.method} ${route.path}`, route])).values()]
  .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
const output = {
  version: 1,
  generatedBy: 'scripts/route-manifest.js',
  routes: normalized,
};
const destination = path.join(root, 'routes.json');
fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`Wrote ${normalized.length} routes to ${path.relative(root, destination)}\n`);
// app.js deliberately starts asynchronous services when it is required. The
// manifest is a build artifact; stop the process once the synchronous walk is
// complete so no database/network connection can keep generation alive.
process.exit(0);
