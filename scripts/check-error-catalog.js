#!/usr/bin/env node
'use strict';

/**
 * Issue #1830 — one shared catalog of API error codes.
 *
 * Checks, in order:
 *  1. Every `code: 'X'` that the backend returns in an error response (a
 *     `code:` literal within a few lines of an `error:` key) is listed in
 *     shared/error-codes.json.
 *  2. Every catalog code has a non-empty English message at
 *     frontend/src/i18n/locales/en.js → errors.<CODE>, so the UI never has to
 *     show a raw server string for a known code.
 *  3. Catalog entries are well formed (category, boolean retryable, userMessageKey).
 *
 * Exit status 1 on any violation, with each violation listed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'shared', 'error-codes.json');
const BACKEND_SRC = path.join(ROOT, 'backend', 'src');
const EN_LOCALE = path.join(ROOT, 'frontend', 'src', 'i18n', 'locales', 'en.js');

// Window (in lines) around a `code:` literal in which an `error` key must appear
// for the literal to count as an API error code.
const ERROR_CONTEXT_LINES = 4;
const CODE_LITERAL = /code:\s*['"]([A-Z][A-Z0-9_]+)['"]/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

/** Collect codes emitted in error responses, with where they were found. */
function emittedCodes(files) {
  const found = new Map();
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      CODE_LITERAL.lastIndex = 0;
      let m;
      while ((m = CODE_LITERAL.exec(line)) !== null) {
        const from = Math.max(0, idx - ERROR_CONTEXT_LINES);
        const to = Math.min(lines.length - 1, idx + ERROR_CONTEXT_LINES);
        const context = lines.slice(from, to + 1).join('\n');
        if (!/\berror\s*:/.test(context)) continue;
        const where = `${path.relative(ROOT, file)}:${idx + 1}`;
        if (!found.has(m[1])) found.set(m[1], []);
        found.get(m[1]).push(where);
      }
    });
  }
  return found;
}

function loadEnglishErrors() {
  const src = fs.readFileSync(EN_LOCALE, 'utf8').replace(/export default/, 'module.exports =');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(src, sandbox, { filename: EN_LOCALE });
  return sandbox.module.exports.errors || {};
}

function main() {
  const problems = [];
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')).codes || {};
  const english = loadEnglishErrors();

  const emitted = emittedCodes(walk(BACKEND_SRC));
  for (const [code, sites] of [...emitted.entries()].sort()) {
    if (!catalog[code]) {
      problems.push(`not in catalog: ${code} (used at ${sites[0]})`);
    }
  }

  for (const [code, entry] of Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))) {
    const message = english[code];
    if (typeof message !== 'string' || message.trim() === '') {
      problems.push(`no English message: errors.${code} in frontend/src/i18n/locales/en.js`);
    }
    if (typeof entry.category !== 'string' || !entry.category) {
      problems.push(`${code}: missing category`);
    }
    if (typeof entry.retryable !== 'boolean') {
      problems.push(`${code}: retryable must be a boolean`);
    }
    if (entry.userMessageKey !== `errors.${code}`) {
      problems.push(`${code}: userMessageKey must be "errors.${code}"`);
    }
  }

  if (problems.length > 0) {
    console.error(`Error catalog check failed (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Add the code to shared/error-codes.json and an English message to en.js.');
    process.exit(1);
  }

  console.log(
    `Error catalog OK: ${Object.keys(catalog).length} codes, ${emitted.size} emitted by the backend.`,
  );
}

main();
