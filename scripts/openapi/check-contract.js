#!/usr/bin/env node
'use strict';

/**
 * OpenAPI contract check (issue #1632). Run in CI:
 *
 *   node scripts/openapi/check-contract.js
 *
 * Fails when:
 *   1. backend/openapi.json is stale relative to the routers — a route is
 *      undocumented, a documented route no longer exists, or its auth
 *      requirements changed (delegates to generate.js --check);
 *   2. the frontend calls a method + path that is not in the spec
 *      (api.<method>(...) calls, apiUrl(...) helpers and '/api/...' literals
 *      anywhere under frontend/src);
 *   3. a Markdown document references "<METHOD> /api/..." for an operation
 *      that is not in the spec.
 *
 * Path parameters match any single segment in both directions, so
 * `/students/${id}` matches `/api/students/{studentId}`.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stripComments, findCalls, splitArgs, ROOT } = require('./extract-routes');

const SPEC_FILE = path.join(ROOT, 'backend/openapi.json');
const FRONTEND_SRC = path.join(ROOT, 'frontend/src');
const API_PREFIX = '/api';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Paths that are deliberately outside the JSON contract.
const NON_CONTRACT_PATHS = new Set([
  '/api/docs', // Swagger UI HTML, mounted only when SWAGGER_ENABLED
]);

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** Normalise a URL-ish string into path segments; template/param pieces become '*'. */
function segments(raw) {
  const p = raw
    .replace(/\$\{[^}]*\}/g, '*')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');
  return p.split('/').filter(Boolean).map((s) => (/^\{.*\}$|^:/.test(s) || s.includes('*') ? '*' : s));
}

function buildMatcher(spec) {
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(item)) {
      if (METHODS.includes(method)) ops.push({ method, segs: segments(p) });
    }
  }
  // lenient: a caller wildcard may also match a static spec segment (frontend
  // template values such as `/reminders/${action}`). Docs use `:param`, which
  // is always a parameter, so they are matched strictly.
  return (method, rawPath, lenient) => {
    const segs = segments(rawPath);
    return ops.some((op) =>
      (!method || op.method === method) &&
      op.segs.length === segs.length &&
      op.segs.every((s, i) => s === '*' || s === segs[i] || (lenient && segs[i] === '*'))
    );
  };
}

/** Literal or template string → its text (templates keep ${...}); null otherwise. */
function urlArg(arg) {
  const m = /^(['"`])([\s\S]*)\1$/.exec((arg || '').trim());
  return m ? m[2] : null;
}

function frontendReferences() {
  const refs = [];
  const files = walk(FRONTEND_SRC, (f) =>
    /\.(jsx?|tsx?)$/.test(f) && !/__tests__|\.test\.|\.spec\./.test(f)
  );
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file);

    // axios instance from services/api.js (baseURL '/api')
    for (const call of findCalls(src, 'api', METHODS)) {
      const url = urlArg(call.args[0]);
      if (url === null || /^https?:/.test(url)) continue;
      refs.push({ method: call.method, path: API_PREFIX + url, where: `${rel}:${lineOf(src, call.index)}` });
    }

    // apiUrl('/x') helper from config/apiBase.js — method not known statically
    const helperRe = /\bapiUrl\s*\(/g;
    let m;
    while ((m = helperRe.exec(src))) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = open;
      for (; close < src.length; close++) {
        if (src[close] === '(') depth++;
        else if (src[close] === ')' && --depth === 0) break;
      }
      const url = urlArg(splitArgs(src.slice(open + 1, close))[0]);
      if (url !== null && url.startsWith('/')) {
        refs.push({ method: null, path: API_PREFIX + url, where: `${rel}:${lineOf(src, m.index)}` });
      }
    }

    // Any other '/api/...' literal (fetch, links, hard-coded URLs)
    const litRe = /(['"`])(\/api\/[^'"`\s]*)\1/g;
    while ((m = litRe.exec(src))) {
      refs.push({ method: null, path: m[2], where: `${rel}:${lineOf(src, m.index)}` });
    }
  }
  return refs;
}

function docReferences() {
  const refs = [];
  const files = [
    path.join(ROOT, 'README.md'),
    ...walk(path.join(ROOT, 'docs'), (f) => f.endsWith('.md')),
  ].filter((f) => fs.existsSync(f));
  const re = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/api\/[A-Za-z0-9_\-./:{}]*)/g;
  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    // The generated endpoint index is derived from the spec itself.
    text = text.replace(/<!-- openapi:index:start[\s\S]*?<!-- openapi:index:end -->/, (s) => s.replace(/[^\n]/g, ' '));
    const rel = path.relative(ROOT, file);
    let m;
    while ((m = re.exec(text))) {
      refs.push({ method: m[1].toLowerCase(), path: m[2].replace(/[.)]+$/, ''), where: `${rel}:${lineOf(text, m.index)}` });
    }
  }
  return refs;
}

function main() {
  let failed = false;

  // 1. Spec vs routers
  const gen = spawnSync(process.execPath, [path.join(__dirname, 'generate.js'), '--check'], { stdio: 'inherit' });
  if (gen.status !== 0) failed = true;

  const spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
  const exists = buildMatcher(spec);

  // 2 + 3. Frontend and docs references
  for (const [label, refs, lenient] of [['Frontend', frontendReferences(), true], ['Docs', docReferences(), false]]) {
    const missing = refs.filter((r) => !NON_CONTRACT_PATHS.has(r.path.split('?')[0]) && !exists(r.method, r.path, lenient));
    if (missing.length) {
      failed = true;
      console.error(`\n${label} references ${missing.length} operation(s) that are not in backend/openapi.json:`);
      for (const r of missing) {
        console.error(`  ${(r.method || 'ANY').toUpperCase().padEnd(6)} ${r.path}   (${r.where})`);
      }
    } else {
      console.log(`${label}: all ${refs.length} API references resolve to documented operations.`);
    }
  }

  if (failed) {
    console.error('\nFix the caller/doc, or the route, so they agree. See docs/README.md and CONTRIBUTING.md.');
    process.exit(1);
  }
}

main();
