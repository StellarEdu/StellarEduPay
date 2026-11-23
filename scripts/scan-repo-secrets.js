#!/usr/bin/env node
/**
 * scripts/scan-repo-secrets.js
 *
 * Issue #1364 — Enhance the repo-wide secret scanner to catch more than just
 * Stellar secret keys.  The scanner now detects:
 *
 *   1. Stellar StrKey secret keys  (S + 55 Base32 chars)
 *   2. BIP-39 mnemonic phrases     (12+ consecutive lowercase words)
 *   3. Realistic hex secrets       (64 or 128 hex chars on a KEY=value line)
 *
 * All three checks share a single allowlist mechanism backed by
 * security-exceptions.json at the repo root.  Add an entry there to
 * permanently silence a known-safe match (e.g. test fixtures, documentation
 * examples) without editing this script.
 *
 * Allowlist entry shape:
 * {
 *   "type":    "stellar-secret" | "mnemonic" | "hex-secret",
 *   "file":    "relative/path/from/repo/root",
 *   "line":    <1-based line number>,   // optional — omit to silence all
 *                                       // matches in the file for that type
 *   "reason":  "human-readable note"
 * }
 *
 * Run manually:  node scripts/scan-repo-secrets.js
 * Run in CI:     'secret-scan-repo' job in .github/workflows/ci.yml
 *
 * Exit code 0 → clean.  Exit code 1 → one or more violations found.
 */

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..');
const EXCEPTIONS_FILE = path.join(REPO_ROOT, 'security-exceptions.json');

// ── Detection patterns ───────────────────────────────────────────────────────

/**
 * 1. Stellar secret key (StrKey, S-prefix, 56 chars total).
 *    Matched as a standalone token to avoid false-positives on identifiers
 *    that happen to start with S.
 */
const STELLAR_SECRET_KEY = /(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g;

/**
 * 2. BIP-39 mnemonic phrase (#2022).
 *
 *    A candidate is a run of exactly 12, 15, 18, 21 or 24 consecutive words
 *    separated by single spaces, where every word is in the official BIP-39
 *    English wordlist AND the phrase passes the BIP-39 checksum. Ordinary
 *    English sentences made of common words (school, budget, service) are
 *    in the wordlist, so word matching alone flags prose. The checksum
 *    rejects random word runs with probability 1 - 2^-CS (CS = 4 bits for
 *    12 words up to 8 bits for 24 words).
 *
 *    The wordlist is scripts/lib/bip39-english.txt (sha256
 *    2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda).
 */
const BIP39_WORDLIST_FILE = path.join(REPO_ROOT, 'scripts', 'lib', 'bip39-english.txt');
const BIP39_VALID_WORD_COUNTS = [12, 15, 18, 21, 24];
const BIP39_WORDS = fs
  .readFileSync(BIP39_WORDLIST_FILE, 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);
const BIP39_INDEX = new Map(BIP39_WORDS.map((w, i) => [w, i]));

/**
 * 3. Realistic hex secret assigned via KEY=value (env-file style or inline).
 *    We require exactly 64 or 128 hex characters on the *value* side of an
 *    assignment.  Values that are obviously fake (all-zeros, sequential,
 *    single-char repeated) are excluded by OBVIOUSLY_FAKE_HEX below.
 *
 *    The pattern is intentionally anchored to `KEY=value` lines (the key
 *    must be an UPPER_SNAKE_CASE identifier) so that random SHA hashes in
 *    comments or URLs don't trigger it.
 */
const HEX_SECRET_LINE = /^[A-Z][A-Z0-9_]*=([0-9a-f]{64}|[0-9a-f]{128})\b/;

/**
 * Patterns that match obviously-fake/placeholder hex values and should be
 * excluded from the hex-secret check.
 */
const OBVIOUSLY_FAKE_HEX = [
  /^0{64}$/,                           // all zeros (64)
  /^0{128}$/,                          // all zeros (128)
  /^(?:0123456789abcdef){4}$/,         // sequential block ×4  (64 chars)
  /^(?:0123456789abcdef){8}$/,         // sequential block ×8  (128 chars)
  /^(?:abcdef0123456789){4}$/,         // reverse sequential   (64 chars)
  /^(?:abcdef0123456789){8}$/,         // reverse sequential   (128 chars)
  /^([\da-f])\1{63}$/,                 // all same digit/letter (64)
  /^([\da-f])\1{127}$/,               // all same digit/letter (128)
  /replace[_\-]?me/i,                  // explicit placeholder label in value
  /your[_\-]?secret/i,
];

/**
 * BIP-39 checksum: the entropy is followed by its first CS bits of SHA-256,
 * where CS = word count / 3. Returns true when the phrase is self-consistent.
 *
 * @param {number[]} indices - wordlist index of each word (11 bits each)
 */
function bip39ChecksumValid(indices) {
  const csBits = indices.length / 3;
  const entBits = indices.length * 11 - csBits;
  const bits = indices.map((i) => i.toString(2).padStart(11, '0')).join('');
  const entropy = Buffer.alloc(entBits / 8);
  for (let i = 0; i < entBits / 8; i++) {
    entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  const hash = crypto.createHash('sha256').update(entropy).digest();
  const expected = hash[0].toString(2).padStart(8, '0').slice(0, csBits);
  return bits.slice(entBits) === expected;
}

/**
 * Finds valid BIP-39 mnemonic candidates on a single line.
 *
 * @param {string} line
 * @returns {string[]} the matched phrases (empty when none)
 */
function findMnemonicCandidates(line) {
  const tokens = [];
  const tokenRe = /(?<![A-Za-z0-9])[a-z]+(?![A-Za-z0-9])/g;
  let m;
  while ((m = tokenRe.exec(line)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }

  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!BIP39_INDEX.has(tokens[i].word)) continue;
    for (const count of BIP39_VALID_WORD_COUNTS) {
      if (i + count > tokens.length) break;
      const window = tokens.slice(i, i + count);
      const contiguous = window.every((t, j) =>
        BIP39_INDEX.has(t.word) && (j === 0 || line.slice(window[j - 1].end, t.start) === ' ')
      );
      if (!contiguous) continue;
      const indices = window.map((t) => BIP39_INDEX.get(t.word));
      if (!bip39ChecksumValid(indices)) continue;
      found.push(line.slice(window[0].start, window[count - 1].end));
      i += count - 1;
      break;
    }
  }
  return found;
}

// ── Allowlist ────────────────────────────────────────────────────────────────

/**
 * Load security-exceptions.json.  If the file is missing or malformed we
 * emit a warning and continue with an empty allowlist — we'd rather have
 * false-positives than silently skip checks.
 *
 * @returns {Array<{type: string, file: string, line?: number, reason?: string}>}
 */
function loadExceptions() {
  if (!fs.existsSync(EXCEPTIONS_FILE)) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8'));
    // Support both the legacy format (top-level array) and the current format
    // used by check-dependency-audit.js ({description, exceptions: [...]}).
    const list = Array.isArray(raw) ? raw : (raw.exceptions || []);
    // Filter to only entries that are relevant to this scanner (they have a
    // "type" field from the set we understand).
    return list.filter(
      (e) => e && typeof e === 'object' && ['stellar-secret', 'mnemonic', 'hex-secret'].includes(e.type)
    );
  } catch (err) {
    console.warn(`⚠️  Could not parse ${EXCEPTIONS_FILE}: ${err.message}. Ignoring allowlist.`);
    return [];
  }
}

/**
 * Returns true if this specific finding is covered by an allowlist entry.
 *
 * @param {string}  type    - 'stellar-secret' | 'mnemonic' | 'hex-secret'
 * @param {string}  relPath - relative file path (from repo root)
 * @param {number}  lineNo  - 1-based line number
 * @param {Array}   exceptions
 */
function isAllowed(type, relPath, lineNo, exceptions) {
  return exceptions.some((e) => {
    if (e.type !== type) return false;
    if (e.file !== relPath) return false;
    // If the exception specifies a line, it must match exactly.
    if (e.line !== undefined && e.line !== null && e.line !== lineNo) return false;
    return true;
  });
}

// ── File helpers ─────────────────────────────────────────────────────────────

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function isProbablyBinary(buffer) {
  // A NUL byte in the first 8 KB is a reliable binary signal.
  return buffer.subarray(0, 8000).includes(0);
}

// ── Main scan ────────────────────────────────────────────────────────────────

const exceptions = loadExceptions();
let violations = 0;

for (const relPath of listTrackedFiles()) {
  const absPath = path.join(REPO_ROOT, relPath);

  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    // Deleted-but-still-staged, submodule pointer, etc. — skip.
    continue;
  }

  if (isProbablyBinary(buffer)) continue;

  const text = buffer.toString('utf8');
  const lines = text.split('\n');

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // ── 1. Stellar secret key ──────────────────────────────────────────────
    const stellarMatches = line.match(STELLAR_SECRET_KEY);
    if (stellarMatches) {
      for (const match of stellarMatches) {
        if (isAllowed('stellar-secret', relPath, lineNo, exceptions)) continue;
        console.error(
          `❌  ${relPath}:${lineNo} — Stellar secret key (S-prefix StrKey) detected: ${match.slice(0, 6)}…\n` +
          `   Real Stellar secret keys must never be committed. Generate a fresh keypair\n` +
          `   at runtime (Keypair.random()) or add to security-exceptions.json if this is\n` +
          `   a test fixture that cannot use a random key.`
        );
        violations++;
      }
    }

    // ── 2. BIP-39 mnemonic ────────────────────────────────────────────────
    const mnemonicMatches = findMnemonicCandidates(line);
    if (mnemonicMatches.length > 0) {
      for (const match of mnemonicMatches) {
        if (isAllowed('mnemonic', relPath, lineNo, exceptions)) continue;
        const preview = match.split(' ').slice(0, 3).join(' ');
        console.error(
          `❌  ${relPath}:${lineNo} — Value looks like a BIP-39 mnemonic phrase: "${preview}…"\n` +
          `   Mnemonic phrases must never be committed. Replace with a placeholder or\n` +
          `   add to security-exceptions.json if this is intentional test data.`
        );
        violations++;
      }
    }

    // ── 3. Realistic hex secret ───────────────────────────────────────────
    const hexMatch = line.trim().match(HEX_SECRET_LINE);
    if (hexMatch) {
      const hexValue = hexMatch[1];
      const isFake = OBVIOUSLY_FAKE_HEX.some((pat) => pat.test(hexValue));
      if (!isFake) {
        if (!isAllowed('hex-secret', relPath, lineNo, exceptions)) {
          console.error(
            `❌  ${relPath}:${lineNo} — Realistic hex secret detected (${hexValue.length} chars).\n` +
            `   Secrets generated by openssl rand -hex must never be committed in plaintext.\n` +
            `   Replace with a clearly-fake placeholder or add to security-exceptions.json.`
          );
          violations++;
        }
      }
    }
  });
}

// ── Result ───────────────────────────────────────────────────────────────────

if (violations === 0) {
  console.log(
    '✅  scan-repo-secrets: no secret material (Stellar keys, mnemonics, hex secrets) found in tracked files.'
  );
  process.exit(0);
} else {
  console.error(
    `\n❌  scan-repo-secrets: ${violations} violation(s) found.\n` +
    `   See docs/security.md for the secrets-management approach.\n` +
    `   To silence a known-safe match add an entry to security-exceptions.json.`
  );
  process.exit(1);
}
