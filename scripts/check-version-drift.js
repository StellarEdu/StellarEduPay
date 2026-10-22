#!/usr/bin/env node
/**
 * check-version-drift.js
 *
 * Two independent drift checks, run in sequence:
 *
 * 1. Dependency version drift
 *    Fails if any shared dependency's declared major version differs between
 *    the root package.json and any workspace package.json (backend, frontend).
 *
 * 2. Dockerfile ↔ .nvmrc runtime drift
 *    Fails if the Node major baked into any Dockerfile (via ARG NODE_VERSION
 *    or a bare FROM node:XX line) differs from the major in the root .nvmrc.
 *
 * Usage:
 *   node scripts/check-version-drift.js
 *
 * Exit codes:
 *   0 — no drift detected
 *   1 — one or more drift violations found
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Parse major version from a semver range string (e.g. "^8.0.0" → 8). */
function parseMajor(range) {
  if (!range) return null;
  // Strip leading range specifiers: ^, ~, >=, <=, =, >, <, whitespace
  const cleaned = range.replace(/^[~^>=<\s]+/, '').trim();
  const match = cleaned.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Read and parse a package.json file, returning its combined dependencies map. */
function readDeps(pkgPath) {
  const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return Object.assign(
    {},
    raw.dependencies || {},
    raw.devDependencies || {},
    raw.peerDependencies || {}
  );
}

const workspaces = [
  { label: 'backend', pkgPath: path.join(ROOT, 'backend', 'package.json') },
  { label: 'frontend', pkgPath: path.join(ROOT, 'frontend', 'package.json') },
];

const rootDeps = readDeps(path.join(ROOT, 'package.json'));

let violations = 0;

for (const ws of workspaces) {
  if (!fs.existsSync(ws.pkgPath)) {
    continue;
  }
  const wsDeps = readDeps(ws.pkgPath);

  for (const [pkg, wsRange] of Object.entries(wsDeps)) {
    if (!(pkg in rootDeps)) continue; // package not in root — no drift to detect

    const rootMajor = parseMajor(rootDeps[pkg]);
    const wsMajor = parseMajor(wsRange);

    if (rootMajor === null || wsMajor === null) continue; // non-semver range, skip

    if (rootMajor !== wsMajor) {
      console.error(
        `[version-drift] MISMATCH: "${pkg}" — root declares major ${rootMajor} ` +
          `(${rootDeps[pkg]}), ${ws.label} declares major ${wsMajor} (${wsRange})`
      );
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} major-version drift violation(s) found. ` +
      'Align the version ranges in the affected package.json files and re-run.'
  );
  process.exit(1);
} else {
  console.log('check-version-drift: no major-version drift detected.');
}

// ── Dockerfile ↔ .nvmrc drift check ─────────────────────────────────────────
//
// Reads the Node major from the root .nvmrc and compares it with the ARG
// NODE_VERSION default (or a bare FROM node:XX-alpine line) in every
// Dockerfile listed below.  Exits non-zero if any major mismatches.
//
// Parsing rules (in order of precedence):
//   1. `ARG NODE_VERSION=<major>`  — preferred; used by our Dockerfiles
//   2. `FROM node:<major>-alpine`  — fallback for bare FROM lines
//   3. `FROM node:<major>`         — fallback, no suffix
//
// The check is intentionally strict about MAJOR only so that patch bumps
// in .nvmrc (e.g. 24.11.0 → 24.12.0) do not require a Dockerfile edit.

/** Extract the numeric Node major embedded in a Dockerfile string. */
function parseDockerfileNodeMajor(content) {
  // 1. ARG NODE_VERSION=<number>
  const argMatch = content.match(/^\s*ARG\s+NODE_VERSION\s*=\s*(\d+)/m);
  if (argMatch) return parseInt(argMatch[1], 10);

  // 2. FROM node:<number>-...  or  FROM node:<number>
  const fromMatch = content.match(/^\s*FROM\s+node:(\d+)/m);
  if (fromMatch) return parseInt(fromMatch[1], 10);

  return null;
}

/** Extract the Node major from a .nvmrc file (e.g. "24.11.0" or "24"). */
function parseNvmrcMajor(content) {
  const cleaned = content.trim().replace(/^v/, '');
  const match = cleaned.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

const nvmrcPath = path.join(ROOT, '.nvmrc');
if (!fs.existsSync(nvmrcPath)) {
  console.error('[dockerfile-drift] ERROR: root .nvmrc not found — cannot check Dockerfile drift.');
  process.exit(1);
}

const nvmrcMajor = parseNvmrcMajor(fs.readFileSync(nvmrcPath, 'utf8'));
if (nvmrcMajor === null) {
  console.error('[dockerfile-drift] ERROR: could not parse a Node version from root .nvmrc.');
  process.exit(1);
}

const dockerfiles = [
  { label: 'backend/Dockerfile', filePath: path.join(ROOT, 'backend', 'Dockerfile') },
  { label: 'frontend/Dockerfile', filePath: path.join(ROOT, 'frontend', 'Dockerfile') },
];

let dockerViolations = 0;

for (const { label, filePath } of dockerfiles) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[dockerfile-drift] WARNING: ${label} not found — skipping.`);
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const dockerMajor = parseDockerfileNodeMajor(content);

  if (dockerMajor === null) {
    console.error(
      `[dockerfile-drift] ERROR: could not determine Node major from ${label}. ` +
        'Add "ARG NODE_VERSION=<major>" before the first FROM instruction.'
    );
    dockerViolations++;
    continue;
  }

  if (dockerMajor !== nvmrcMajor) {
    console.error(
      `[dockerfile-drift] MISMATCH: ${label} uses Node major ${dockerMajor} ` +
        `but .nvmrc pins major ${nvmrcMajor}. ` +
        `Update the ARG NODE_VERSION default in ${label}.`
    );
    dockerViolations++;
  } else {
    console.log(
      `[dockerfile-drift] OK: ${label} Node major (${dockerMajor}) matches .nvmrc major (${nvmrcMajor}).`
    );
  }
}

if (dockerViolations > 0) {
  console.error(
    `\n${dockerViolations} Dockerfile/runtime drift violation(s) found. ` +
      'Align the NODE_VERSION ARG defaults with the root .nvmrc and re-run.'
  );
  process.exit(1);
}
