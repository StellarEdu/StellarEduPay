#!/usr/bin/env node
/**
 * scripts/scan-repo-secrets.js
 *
 * Issue #1386 — signerKeyManager.js encrypts school signing keys under a
 * master key, but that protection is worthless if a real Stellar secret key
 * (S...) is ever committed to the repository in plaintext (e.g. pasted into
 * a fixture, a script, or a comment during local testing).
 *
 * Scans every git-tracked file (excluding node_modules/.git, which aren't
 * tracked anyway, and binary files) for the Stellar StrKey secret-key
 * format: 'S' followed by 55 base32 characters (A-Z, 2-7), encoding exactly
 * 32 bytes. This is broader than scripts/scan-example-secrets.js, which only
 * covers the small set of .env.example template files — this script covers
 * the whole repository.
 *
 * Run manually:  node scripts/scan-repo-secrets.js
 * Run in CI:     'secret-scan-repo' job in .github/workflows/ci.yml
 *
 * Exit code 0 → clean. Exit code 1 → one or more violations found.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Same pattern as scan-example-secrets.js: a real secret key starts with S
// and encodes exactly 32 bytes in Stellar's modified Base32 alphabet.
// Matched as a standalone token (not embedded inside a longer word) to avoid
// false positives on unrelated identifiers.
const STELLAR_SECRET_KEY = /(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g;

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function isProbablyBinary(buffer) {
  // A NUL byte in the first few KB is a reliable binary signal; text source
  // files never legitimately contain one.
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

let violations = 0;

for (const relPath of listTrackedFiles()) {
  const absPath = path.join(REPO_ROOT, relPath);

  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    // Deleted-but-still-staged, a submodule pointer, etc. — nothing to scan.
    continue;
  }

  if (isProbablyBinary(buffer)) continue;

  const text = buffer.toString('utf8');
  const lines = text.split('\n');

  lines.forEach((line, idx) => {
    const matches = line.match(STELLAR_SECRET_KEY);
    if (!matches) return;
    for (const match of matches) {
      console.error(
        `❌  ${relPath}:${idx + 1} — Stellar secret key (S-prefix StrKey) detected: ${match.slice(0, 6)}…\n` +
        `   Real Stellar secret keys must never be committed. If this is test/fixture data, ` +
        `generate a fresh random keypair at runtime (Keypair.random()) instead of hardcoding one.`
      );
      violations++;
    }
  });
}

if (violations === 0) {
  console.log('✅  scan-repo-secrets: no Stellar secret key material found in tracked files.');
  process.exit(0);
} else {
  console.error(
    `\n❌  scan-repo-secrets: ${violations} violation(s) found.\n` +
    `   See docs/security.md for the signer key secrets-management approach.`
  );
  process.exit(1);
}
