'use strict';

/**
 * Static Express route extractor (issue #1632).
 *
 * Reads backend/src/app.js and the routers it mounts, without loading them
 * (no database, Redis or env vars needed), and returns every reachable
 * operation with the auth middleware that guards it:
 *
 *   [{ method: 'get', path: '/api/schools/{schoolId}', auth: 'admin',
 *      roles: [], schoolContext: false, source: 'backend/src/routes/schoolRoutes.js' }]
 *
 * Routers that exist on disk but are never mounted are deliberately ignored —
 * they are unreachable, so they are not part of the contract.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const APP_FILE = path.join(ROOT, 'backend/src/app.js');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// ── Tiny JS scanner ──────────────────────────────────────────────────────────

/** Replace comments with spaces, keeping string/template literals intact. */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the string literal starting at i. */
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\') j++;
    j++;
  }
  return j + 1;
}

/** Given the index of an opening paren/bracket, return the index of its match. */
function matchClose(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i++;
  }
  return i - 1;
}

/** Split an argument list on top-level commas. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) args.push(last);
  return args;
}

/** Parse a plain string literal ('x', "x", `x` without ${}); null otherwise. */
function stringLiteral(arg) {
  const m = /^(['"`])([^'"`]*)\1$/.exec(arg.trim());
  if (!m || (m[1] === '`' && m[2].includes('${'))) return null;
  return m[2];
}

/** Every `<receiver>.<method>(...)` call in source order. */
function findCalls(src, receiver, methods) {
  const re = new RegExp(`\\b${receiver}\\s*\\.\\s*(${methods.join('|')})\\s*\\(`, 'g');
  const calls = [];
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open);
    calls.push({ method: m[1], args: splitArgs(src.slice(open + 1, close)), index: m.index });
    re.lastIndex = close;
  }
  return calls;
}

/** Top-level `const NAME = <expr>;` declarations, for resolving middleware aliases. */
function constDeclarations(src) {
  const decls = {};
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(src, i) - 1; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if ((c === ';' || c === '\n') && depth === 0) break;
    }
    decls[m[1]] = src.slice(re.lastIndex, i);
  }
  return decls;
}

// ── Auth classification ──────────────────────────────────────────────────────

/**
 * Inspect middleware argument text and accumulate what it implies.
 * @param {string[]} args
 * @param {object} decls  const declarations of the file (alias resolution)
 * @param {object} acc    { auth, roles, schoolContext }
 */
function classifyMiddleware(args, decls, acc) {
  for (const raw of args) {
    const text = /^[A-Za-z_$][\w$]*$/.test(raw) && decls[raw] ? `${raw} ${decls[raw]}` : raw;
    if (/\brequireAdminAuth\b/.test(text)) acc.auth = 'admin';
    const school = /\brequireSchoolAuth\s*\(([^)]*)\)/.exec(text);
    if (school) {
      if (acc.auth !== 'admin') acc.auth = 'school';
      const roles = school[1].match(/['"]([\w-]+)['"]/g);
      if (roles) acc.roles = roles.map((r) => r.slice(1, -1));
    }
    if (/\bresolveSchool\b/.test(text)) acc.schoolContext = true;
  }
  return acc;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function joinPaths(prefix, sub) {
  const joined = `${prefix.replace(/\/+$/, '')}/${sub.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return joined || '/';
}

/** Express path → OpenAPI path ('/a/:id' → '/a/{id}'). */
function toOpenApiPath(expressPath) {
  return expressPath
    .replace(/\{\/:([A-Za-z_]\w*)\}/g, '/{$1}')
    .replace(/:([A-Za-z_]\w*)(\([^)]*\))?\??/g, '{$1}')
    .replace(/\*([A-Za-z_]\w*)/g, '{$1}');
}

// ── Router / app parsing ─────────────────────────────────────────────────────

function parseRouter(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const decls = constDeclarations(src);
  const routes = [];
  const globalMw = [];      // router.use(mw) — applies to routes declared after it
  const scopedMw = [];      // router.use('/prefix', mw)

  for (const call of findCalls(src, 'router', [...HTTP_METHODS, 'use'])) {
    if (call.method === 'use') {
      const prefix = stringLiteral(call.args[0] || '');
      if (prefix !== null) scopedMw.push({ prefix, args: call.args.slice(1) });
      else globalMw.push(...call.args);
      continue;
    }
    const first = call.args[0] || '';
    let paths = [];
    if (first.startsWith('[')) {
      paths = splitArgs(first.slice(1, -1)).map(stringLiteral).filter((p) => p !== null);
    } else {
      const p = stringLiteral(first);
      if (p !== null) paths = [p];
    }
    for (const p of paths) {
      const acc = classifyMiddleware(globalMw, decls, { auth: 'public', roles: [], schoolContext: false });
      for (const s of scopedMw) {
        if (joinPaths('/', p).startsWith(joinPaths('/', s.prefix))) classifyMiddleware(s.args, decls, acc);
      }
      classifyMiddleware(call.args.slice(1), decls, acc);
      routes.push({ method: call.method, subPath: p, ...acc });
    }
  }
  return routes;
}

function extractRoutes() {
  const src = stripComments(fs.readFileSync(APP_FILE, 'utf8'));
  const decls = constDeclarations(src);
  const routerFiles = {};
  const reqRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.\/routes\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = reqRe.exec(src))) {
    routerFiles[m[1]] = require.resolve(path.join(path.dirname(APP_FILE), m[2]));
  }

  const operations = [];
  const seen = new Set();
  const add = (op) => {
    const key = `${op.method} ${op.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    operations.push(op);
  };

  for (const call of findCalls(src, 'app', [...HTTP_METHODS, 'use'])) {
    const prefix = stringLiteral(call.args[0] || '');
    if (prefix === null) continue;

    if (call.method === 'use') {
      const routerArg = call.args.slice(1).find((a) => routerFiles[a]);
      if (!routerArg) continue;
      const file = routerFiles[routerArg];
      const mountMw = call.args.slice(1).filter((a) => a !== routerArg);
      for (const r of parseRouter(file)) {
        const acc = classifyMiddleware(mountMw, decls, { auth: r.auth, roles: r.roles, schoolContext: r.schoolContext });
        add({
          method: r.method,
          path: toOpenApiPath(joinPaths(prefix, r.subPath)),
          auth: acc.auth,
          roles: acc.roles,
          schoolContext: acc.schoolContext,
          source: path.relative(ROOT, file),
        });
      }
    } else {
      const acc = classifyMiddleware(call.args.slice(1), decls, { auth: 'public', roles: [], schoolContext: false });
      add({
        method: call.method,
        path: toOpenApiPath(prefix),
        ...acc,
        source: path.relative(ROOT, APP_FILE),
      });
    }
  }

  return operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

module.exports = { extractRoutes, toOpenApiPath, stripComments, findCalls, splitArgs, stringLiteral, ROOT };

if (require.main === module) {
  for (const op of extractRoutes()) {
    console.log(`${op.method.toUpperCase().padEnd(6)} ${op.path}  [${op.auth}${op.roles.length ? `:${op.roles.join('|')}` : ''}${op.schoolContext ? ' +school' : ''}]`);
  }
}
