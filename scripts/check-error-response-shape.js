#!/usr/bin/env node

/**
 * 401/403 response shape check
 *
 * The README documents a canonical `{ error, code }` shape for auth failure
 * responses. A `res.status(401)`/`res.status(403)` JSON body that omits
 * `code` silently breaks frontend error handling (errorMessages.js keys off
 * `code`, not the free-text `error` message). See issue #1417.
 *
 * This is a source scan, not a runtime test: it flags any
 * `res.status(401|403).json({ ... })` call literal in backend/src whose
 * object body has no `code` property. Non-JSON responses (e.g.
 * metricsAuth.js's `.send()` for Basic Auth) are out of scope.
 */

const fs = require('fs');
const path = require('path');

const SCAN_ROOT = path.join(__dirname, '../backend/src');
const IGNORED_DIRS = new Set(['node_modules', 'coverage', '.git', 'dist', 'build', '.next']);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Matches `res.status(401).json({` / `res.status(403).json({` (any
// intervening whitespace/newlines), capturing the status call site.
const CALL_RE = /res\s*\.\s*status\s*\(\s*(401|403)\s*\)\s*\.\s*json\s*\(\s*\{/g;

function findMatchingBrace(source, openBraceIndex) {
  let depth = 1;
  for (let i = openBraceIndex + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const issues = [];
  let match;

  CALL_RE.lastIndex = 0;
  while ((match = CALL_RE.exec(source)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace === -1) continue;

    const body = source.slice(openBrace, closeBrace + 1);
    // Matches `code: ...` and the ES2015 shorthand property `code` (e.g.
    // `{ error: reason, code }`) — both satisfy the canonical shape.
    const hasCodeField = /\bcode\s*:/.test(body) || /[{,]\s*code\s*[,}]/.test(body);
    if (!hasCodeField) {
      const line = source.slice(0, match.index).split('\n').length;
      issues.push(`${path.relative(path.join(__dirname, '..'), file)}:${line} — status(${match[1]}).json() has no 'code' field`);
    }
  }

  return issues;
}

function main() {
  const files = walkFiles(SCAN_ROOT);
  const issues = files.flatMap(checkFile);

  if (issues.length > 0) {
    console.error('❌ 401/403 response shape check failed!\n');
    issues.forEach(issue => console.error(`  ${issue}`));
    console.error('\nEvery 401/403 JSON response must include a `code` field alongside');
    console.error('`error` — see README\'s documented error response shape.');
    process.exit(1);
  }

  console.log('✅ 401/403 response shape check passed! Every response includes a code field.');
  process.exit(0);
}

main();
