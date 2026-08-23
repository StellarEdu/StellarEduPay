#!/usr/bin/env node
/**
 * scripts/check-syntax.js
 *
 * Fast, dependency-light syntax gate run as the first step of the CI `test`
 * job. Its entire purpose is to catch parse errors before they reach a deploy
 * (the exact class of breakage behind the paymentRoutes.js duplicate-import
 * incident).
 *
 * Scope & strategy:
 *   backend/src  (every .js file)        → `node --check` (the real runtime
 *                           parser; this is what catches duplicate
 *                           declarations, invalid syntax in CommonJS sources,
 *                           etc.)
 *   frontend/src (every .js / .jsx file) → @babel/core.parseSync with the JSX
 *                           plugin, because `node --check` cannot parse JSX.
 *                           Babel is already a declared root devDependency
 *                           (used by the Jest transform), so nothing new is
 *                           installed.
 *
 * The file walk itself is pure Node: fs.readdirSync(dir, { recursive: true })
 * (Node >= 18.17; the repo's .nvmrc pins 20.11). No glob dependency.
 *
 * Exit codes — deliberately distinct so a red CI step is unambiguous:
 *   0 → every checked file parsed cleanly
 *   1 → syntax error(s) DETECTED in checked files (names file + line)
 *   2 → the gate itself failed to run (missing dependency, missing directory,
 *       unsupported Node, walked zero files) — NOT a syntax finding
 *
 * Run manually:  npm run check:syntax
 * Run in CI:     .github/workflows/ci.yml → test job → "Syntax check"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ── Targets ───────────────────────────────────────────────────────────────────
// `dir` may be repo-relative (resolved against ROOT) or absolute (used by the
// unit tests to point at fixture trees).
const TARGETS = [
  { label: 'backend/src', dir: 'backend/src', exts: ['.js'], parser: 'node' },
  { label: 'frontend/src', dir: 'frontend/src', exts: ['.js', '.jsx'], parser: 'babel' },
];

// ── Gate-internal failure (distinct from a syntax finding) ────────────────────

class GateError extends Error {}

function gateError(message) {
  throw new GateError(message);
}

// ── File collection (pure stdlib, no glob) ────────────────────────────────────

function collectFiles(target) {
  const absDir = path.isAbsolute(target.dir) ? target.dir : path.join(ROOT, target.dir);

  if (!fs.existsSync(absDir)) {
    gateError(`target directory does not exist: ${absDir}`);
  }

  // Recursive readdir ships since Node 18.17 — asserted by assertEngine().
  const entries = fs.readdirSync(absDir, { recursive: true });

  return entries
    .filter((entry) => target.exts.includes(path.extname(entry)))
    .map((entry) => path.join(absDir, entry))
    .filter((file) => fs.statSync(file).isFile())
    .sort();
}

// ── Parsers ───────────────────────────────────────────────────────────────────

/** Extract the offending line from `node --check` stderr ("<path>:<line>"). */
function extractLine(text) {
  const match = text.match(/:(\d+)\s*$/m) || text.match(/:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function relativize(filePath) {
  return path.relative(ROOT, filePath) || filePath;
}

/** Parse one file with Node's own parser. Returns a problem object or null. */
function checkWithNode(file) {
  const res = spawnSync(process.execPath, ['--check', file], { timeout: 30_000 });

  if (res.status === 0 && !res.error) return null;

  const raw = (res.stderr ? res.stderr.toString() : '') ||
    (res.error ? res.error.message : `node --check exited ${res.status}`);

  const rel = relativize(file);
  return {
    file: rel,
    line: extractLine(raw),
    detail: raw.trim().split('\n').map((line) => line.replace(file, rel)).join('\n'),
  };
}

let babelCache;

function loadBabel() {
  if (babelCache !== undefined) return babelCache;
  try {
    // Declared root devDependency (@babel/core). Required lazily so that pure
    // backend-only invocations do not pay the require cost.
    babelCache = require('@babel/core');
  } catch (err) {
    gateError(
      '@babel/core is required to parse frontend sources but could not be loaded.\n' +
        'It is a declared devDependency in package.json — run `npm ci` at the repository root.'
    );
  }
  return babelCache;
}

/** Parse one file with Babel (JSX-aware). Returns a problem object or null. */
function checkWithBabel(file) {
  const babel = loadBabel();

  let code;
  try {
    code = fs.readFileSync(file, 'utf8');
  } catch (err) {
    gateError(`could not read ${relativize(file)}: ${err.message}`);
  }

  const rel = relativize(file);
  try {
    babel.parseSync(code, {
      filename: file,
      configFile: false,
      babelrc: false,
      browserslistConfigFile: false,
      sourceType: 'unambiguous',
      parserOpts: { plugins: ['jsx'] },
    });
    return null;
  } catch (err) {
    const line = err.loc ? err.loc.line : null;
    return {
      file: rel,
      line,
      // Babel messages already read "<filename>: <message> (line:col)".
      detail: err.message.replace(file, rel),
    };
  }
}

const PARSERS = { node: checkWithNode, babel: checkWithBabel };

// ── Orchestration ─────────────────────────────────────────────────────────────

function assertEngine() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 17)) {
    gateError(
      `Node >= 18.17 required (recursive fs.readdirSync); running ${process.version}. ` +
        'See .nvmrc for the pinned version.'
    );
  }
}

/**
 * Check every target; never calls process.exit (that is the CLI wrapper's job)
 * so the function stays unit-testable.
 *
 * @returns {{ code: number, checked: number, problems: Array<{file: string, line: number|null, detail: string}>, perTarget: Array<{label: string, count: number}> }}
 */
function runChecks(targets = TARGETS, log = console) {
  assertEngine();

  const perTarget = [];
  const problems = [];

  for (const target of targets) {
    const files = collectFiles(target);
    perTarget.push({ label: target.label, count: files.length });

    for (const file of files) {
      const problem = PARSERS[target.parser](file);
      if (problem) problems.push(problem);
    }
  }

  const total = perTarget.reduce((sum, t) => sum + t.count, 0);
  if (total === 0) {
    gateError('walked zero files — target configuration is wrong, refusing to report success');
  }

  for (const p of problems) {
    log.error(`SYNTAX ERROR in ${p.file}${p.line ? `:${p.line}` : ''}\n${p.detail}\n`);
  }

  const scope = perTarget.map((t) => `${t.label}: ${t.count}`).join(', ');
  if (problems.length > 0) {
    log.log(`✗ ${problems.length} of ${total} files failed the syntax check (${scope})`);
  } else {
    log.log(`✓ ${total} files passed the syntax check (${scope})`);
  }

  return { code: problems.length > 0 ? 1 : 0, checked: total, problems, perTarget };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  try {
    process.exit(runChecks().code);
  } catch (err) {
    if (err instanceof GateError) {
      // Startup/configuration failure — MUST be distinguishable from a
      // detected syntax error (exit 1). See header docs.
      console.error(`[check-syntax] GATE ERROR (not a syntax finding): ${err.message}`);
      process.exit(2);
    }
    console.error(`[check-syntax] unexpected failure: ${err.stack || err.message}`);
    process.exit(2);
  }
}

module.exports = { TARGETS, collectFiles, checkWithNode, checkWithBabel, runChecks, GateError };
