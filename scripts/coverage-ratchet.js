#!/usr/bin/env node
'use strict';

/**
 * Coverage ratchet (#1635).
 *
 * Compares the json-summary reports written by `npm run coverage` and
 * `npm run coverage:frontend` against the committed baseline in
 * coverage-baseline.json and fails if coverage went DOWN:
 *
 *   - any global metric (lines/statements/functions/branches) of either
 *     suite drops more than TOLERANCE percentage points below the baseline;
 *   - any file changed in this branch (vs. --base, default origin/main) that
 *     the baseline knows about loses line coverage.
 *
 * Usage:
 *   node scripts/coverage-ratchet.js                 # check (CI)
 *   node scripts/coverage-ratchet.js --markdown out.md   # also write a PR comment
 *   node scripts/coverage-ratchet.js --update        # raise the baseline to current
 *                                                    # coverage and sync the Jest
 *                                                    # global coverageThreshold floors
 *
 * The baseline only ever moves up: --update keeps max(baseline, current).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'coverage-baseline.json');
const METRICS = ['lines', 'statements', 'functions', 'branches'];
const TOLERANCE = 0.1; // percentage points — absorbs rounding noise

const SUITES = {
  backend: {
    summary: path.join(ROOT, 'coverage/backend/coverage-summary.json'),
    stripPrefix: ROOT + path.sep,
  },
  frontend: {
    summary: path.join(ROOT, 'coverage/frontend/coverage-summary.json'),
    stripPrefix: ROOT + path.sep,
  },
};

function parseArgs(argv) {
  const args = { update: false, markdown: null, base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--update') args.update = true;
    else if (argv[i] === '--markdown') args.markdown = argv[++i];
    else if (argv[i] === '--base') args.base = argv[++i];
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Normalise a json-summary report into { total: {metric: pct}, files: {relPath: linesPct} }. */
function loadSuite(name) {
  const raw = readJson(SUITES[name].summary);
  if (!raw) return null;
  const total = {};
  for (const m of METRICS) total[m] = round(raw.total[m].pct);
  const files = {};
  for (const [file, data] of Object.entries(raw)) {
    if (file === 'total') continue;
    const rel = file.startsWith(SUITES[name].stripPrefix)
      ? file.slice(SUITES[name].stripPrefix.length)
      : file;
    files[rel.split(path.sep).join('/')] = round(data.lines.pct);
  }
  return { total, files };
}

function changedFiles(base) {
  try {
    return execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function check(baseline, current, changed) {
  const failures = [];
  const rows = [];
  for (const name of Object.keys(SUITES)) {
    const cur = current[name];
    const base = baseline[name] || { total: {}, files: {} };
    if (!cur) {
      rows.push({ suite: name, missing: true });
      continue;
    }
    for (const m of METRICS) {
      const was = base.total[m];
      const now = cur.total[m];
      const delta = was === undefined ? null : round(now - was);
      rows.push({ suite: name, metric: m, was, now, delta });
      if (was !== undefined && now + TOLERANCE < was) {
        failures.push(`${name} ${m}: ${now}% < baseline ${was}%`);
      }
    }
    for (const file of changed) {
      const was = base.files && base.files[file];
      const now = cur.files[file];
      if (was !== undefined && now !== undefined && now + TOLERANCE < was) {
        failures.push(`${file} lines: ${now}% < baseline ${was}%`);
      }
    }
  }
  return { failures, rows };
}

function toMarkdown(rows, failures) {
  const out = ['<!-- coverage-ratchet -->', '### Coverage report', '', '| Suite | Metric | Baseline | This PR | Δ |', '|---|---|---|---|---|'];
  for (const r of rows) {
    if (r.missing) {
      out.push(`| ${r.suite} | — | — | _no report_ | — |`);
      continue;
    }
    const delta = r.delta === null ? 'new' : `${r.delta > 0 ? '+' : ''}${r.delta}`;
    const icon = r.delta !== null && r.delta < -TOLERANCE ? ' :red_circle:' : '';
    out.push(`| ${r.suite} | ${r.metric} | ${r.was ?? '—'}% | ${r.now}% | ${delta}${icon} |`);
  }
  out.push('');
  if (failures.length) {
    out.push('**Coverage decreased** — the ratchet requires coverage to stay at or above the baseline:', '');
    for (const f of failures) out.push(`- ${f}`);
  } else {
    out.push('Coverage is at or above the baseline. :white_check_mark:');
  }
  return out.join('\n') + '\n';
}

function update(baseline, current) {
  const next = { ...baseline };
  for (const name of Object.keys(SUITES)) {
    const cur = current[name];
    if (!cur) continue;
    const base = baseline[name] || { total: {}, files: {} };
    const total = {};
    for (const m of METRICS) total[m] = Math.max(base.total[m] ?? 0, cur.total[m]);
    const files = { ...(base.files || {}) };
    for (const [f, pct] of Object.entries(cur.files)) files[f] = Math.max(files[f] ?? 0, pct);
    next[name] = { total, files };
  }
  next.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');

  // Keep the Jest global thresholds in step with reality (floored to whole
  // percentages so a rounding wobble does not fail the run).
  const floors = (suite) => Object.fromEntries(METRICS.map((m) => [m, Math.floor(next[suite].total[m])]));
  if (next.backend) {
    const pkgPath = path.join(ROOT, 'package.json');
    const pkg = readJson(pkgPath);
    pkg.jest.coverageThreshold.global = floors('backend');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  if (next.frontend) {
    const cfgPath = path.join(ROOT, 'frontend/jest.config.js');
    const src = fs.readFileSync(cfgPath, 'utf8');
    const f = floors('frontend');
    const replaced = src.replace(
      /global:\s*\{[^}]*\}/,
      `global: {\n      branches: ${f.branches},\n      functions: ${f.functions},\n      lines: ${f.lines},\n      statements: ${f.statements},\n    }`
    );
    fs.writeFileSync(cfgPath, replaced);
  }
  console.log(`✓ coverage-baseline.json updated; Jest global thresholds synced`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = readJson(BASELINE_PATH) || {};
  const current = { backend: loadSuite('backend'), frontend: loadSuite('frontend') };

  if (!current.backend && !current.frontend) {
    console.error('No coverage-summary.json found — run `npm run coverage` and `npm run coverage:frontend` first.');
    process.exit(1);
  }

  if (args.update) {
    update(baseline, current);
    return;
  }

  const { failures, rows } = check(baseline, current, changedFiles(args.base));
  if (args.markdown) fs.writeFileSync(args.markdown, toMarkdown(rows, failures));

  for (const r of rows) {
    if (!r.missing) console.log(`${r.suite.padEnd(9)} ${r.metric.padEnd(11)} ${String(r.now).padStart(6)}%  (baseline ${r.was ?? '—'}%)`);
  }
  if (failures.length) {
    console.error('\n✗ Coverage decreased:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('\n✓ Coverage at or above baseline');
}

main();
