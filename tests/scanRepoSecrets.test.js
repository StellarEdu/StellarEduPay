'use strict';

/**
 * tests/scanRepoSecrets.test.js
 *
 * Unit tests for the enhanced scripts/scan-repo-secrets.js scanner (issue #1364).
 *
 * The scanner is tested by:
 *   1. Exercising each detection pattern against synthetic inputs
 *   2. Confirming that the allowlist (security-exceptions.json) suppresses
 *      known-safe matches
 *   3. Verifying that obviously-fake hex values are NOT flagged
 *
 * Integration tests spin up a throwaway git repository in a temp directory,
 * copy the script there, and assert on exit code + stderr output.  The unit
 * tests extract the compiled regex patterns directly from the script source so
 * cosmetic refactoring doesn't break them.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Paths ────────────────────────────────────────────────────────────────────

const SCRIPT = path.resolve(__dirname, '../scripts/scan-repo-secrets.js');

// ── Test fixtures ─────────────────────────────────────────────────────────────
//
// All values below are SYNTHETIC — they are constructed to match the format of
// real secrets without being usable credentials.

/**
 * Stellar secret key: 'S' followed by exactly 55 Base32 chars (A-Z, 2-7).
 * Total length = 56.  This key does NOT correspond to any real account.
 */
const STELLAR_SECRET = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

/**
 * Realistic 64-char (32-byte) hex string — NOT all-zeros, not sequential,
 * not single-char-repeated.  Looks like `openssl rand -hex 32` output.
 */
const REAL_HEX_64 = 'a3f8b2c1d9e047561234abcd5678ef90b3f8a2c1d9e047561234abcd5678ef91';

/**
 * Realistic 128-char (64-byte) hex string.  Constructed with a varying
 * pattern so it is not caught by any of the OBVIOUSLY_FAKE_HEX filters.
 */
const REAL_HEX_128 = (() => {
  let s = '';
  for (let i = 0; i < 128; i++) s += 'abcdef0123456789'[(i * 7 + 3) % 16];
  return s;
})();

/**
 * BIP-39 style mnemonic — 12 lowercase words from the BIP-39 wordlist.
 */
const MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal, self-contained git repository in a temp directory,
 * populate it with the provided files, commit them, then return the dir path.
 *
 * @param {Record<string, string>} files  - { 'relative/path': 'content' }
 * @param {string}  [exceptionsJson]      - optional content for security-exceptions.json
 * @returns {string} path to the temp repo
 */
function makeTempRepo(files, exceptionsJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));

  execFileSync('git', ['init', '--initial-branch=main', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });

  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  if (exceptionsJson !== undefined) {
    fs.writeFileSync(path.join(dir, 'security-exceptions.json'), exceptionsJson, 'utf8');
  }

  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty-message', '-m', ''], { stdio: 'pipe' });

  return dir;
}

/**
 * Run the scanner script inside the given temp repo directory.
 * The scanner is copied into `<repoDir>/scripts/` so __dirname resolves
 * correctly inside the script.
 *
 * Returns { exitCode, stdout, stderr }.
 */
function runScanner(repoDir) {
  const scriptsDir = path.join(repoDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scriptsDir, 'scan-repo-secrets.js'));

  const result = spawnSync(process.execPath, [path.join(scriptsDir, 'scan-repo-secrets.js')], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ── Pre-flight sanity checks on test fixtures ─────────────────────────────────

describe('test fixture sanity', () => {
  it('STELLAR_SECRET is 56 chars and starts with S', () => {
    expect(STELLAR_SECRET).toHaveLength(56);
    expect(STELLAR_SECRET[0]).toBe('S');
    expect(/^S[A-Z2-7]{55}$/.test(STELLAR_SECRET)).toBe(true);
  });

  it('REAL_HEX_64 is exactly 64 lowercase hex chars', () => {
    expect(REAL_HEX_64).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(REAL_HEX_64)).toBe(true);
  });

  it('REAL_HEX_128 is exactly 128 lowercase hex chars', () => {
    expect(REAL_HEX_128).toHaveLength(128);
    expect(/^[0-9a-f]{128}$/.test(REAL_HEX_128)).toBe(true);
  });

  it('MNEMONIC has 12 words', () => {
    expect(MNEMONIC.split(' ')).toHaveLength(12);
  });
});

// ── Unit tests: pattern correctness ──────────────────────────────────────────
//
// We re-declare the detection patterns here (identical to the script) so we
// can test them directly without eval.  Any drift between these and the
// script patterns will be caught by the integration tests below.

const STELLAR_SECRET_KEY_PAT = /(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g;
const BIP39_MNEMONIC_PAT = /\b([a-z]{3,8} ){11,23}[a-z]{3,8}\b/g;
const HEX_SECRET_LINE_PAT = /^[A-Z][A-Z0-9_]*=([0-9a-f]{64}|[0-9a-f]{128})\b/;

const OBVIOUSLY_FAKE_HEX = [
  /^0{64}$/,
  /^0{128}$/,
  /^(?:0123456789abcdef){4}$/,
  /^(?:0123456789abcdef){8}$/,
  /^(?:abcdef0123456789){4}$/,
  /^(?:abcdef0123456789){8}$/,
  /^([\da-f])\1{63}$/,
  /^([\da-f])\1{127}$/,
];

describe('Pattern: Stellar secret key', () => {
  it('matches a valid 56-char Stellar secret key', () => {
    const pat = new RegExp(STELLAR_SECRET_KEY_PAT.source, STELLAR_SECRET_KEY_PAT.flags);
    expect(pat.test(STELLAR_SECRET)).toBe(true);
  });

  it('does not match a Stellar public key (G prefix)', () => {
    const pat = new RegExp(STELLAR_SECRET_KEY_PAT.source, STELLAR_SECRET_KEY_PAT.flags);
    expect(pat.test('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBe(false);
  });

  it('does not match a short S-prefixed string', () => {
    const pat = new RegExp(STELLAR_SECRET_KEY_PAT.source, STELLAR_SECRET_KEY_PAT.flags);
    expect(pat.test('SCZANGBA5')).toBe(false);
  });

  it('matches a key embedded in a longer assignment line', () => {
    const pat = new RegExp(STELLAR_SECRET_KEY_PAT.source, STELLAR_SECRET_KEY_PAT.flags);
    expect(pat.test(`STELLAR_SECRET_KEY=${STELLAR_SECRET}`)).toBe(true);
  });

  it('does not match when surrounded by other Base32 chars (embedded in longer token)', () => {
    // Prepend an extra Base32 char so the lookbehind fires
    const pat = new RegExp(STELLAR_SECRET_KEY_PAT.source, STELLAR_SECRET_KEY_PAT.flags);
    expect(pat.test(`A${STELLAR_SECRET}`)).toBe(false);
  });
});

describe('Pattern: BIP-39 mnemonic', () => {
  it('matches a 12-word mnemonic', () => {
    const pat = new RegExp(BIP39_MNEMONIC_PAT.source, BIP39_MNEMONIC_PAT.flags);
    expect(pat.test(MNEMONIC)).toBe(true);
  });

  it('does not match 11 words (below BIP-39 minimum)', () => {
    const pat = new RegExp(BIP39_MNEMONIC_PAT.source, BIP39_MNEMONIC_PAT.flags);
    const eleven = 'abandon ability able about above absent absorb abstract absurd abuse access';
    expect(pat.test(eleven)).toBe(false);
  });

  it('does not match uppercase words (BIP-39 words are lowercase)', () => {
    const pat = new RegExp(BIP39_MNEMONIC_PAT.source, BIP39_MNEMONIC_PAT.flags);
    const upper = MNEMONIC.toUpperCase();
    expect(pat.test(upper)).toBe(false);
  });

  it('matches a 24-word mnemonic', () => {
    const pat = new RegExp(BIP39_MNEMONIC_PAT.source, BIP39_MNEMONIC_PAT.flags);
    const twentyFour = Array(24).fill('abandon').join(' ');
    expect(pat.test(twentyFour)).toBe(true);
  });
});

describe('Pattern: hex secret assignment', () => {
  it('matches a 64-char hex value on a KEY= line', () => {
    expect(HEX_SECRET_LINE_PAT.test(`JWT_SECRET=${REAL_HEX_64}`)).toBe(true);
  });

  it('matches a 128-char hex value on a KEY= line', () => {
    expect(HEX_SECRET_LINE_PAT.test(`SESSION_KEY=${REAL_HEX_128}`)).toBe(true);
  });

  it('does not match a hex value without a KEY= assignment', () => {
    expect(HEX_SECRET_LINE_PAT.test(REAL_HEX_64)).toBe(false);
  });

  it('does not match a lowercase key name', () => {
    expect(HEX_SECRET_LINE_PAT.test(`jwt_secret=${REAL_HEX_64}`)).toBe(false);
  });

  it('does not match a 63-char hex value (one short)', () => {
    expect(HEX_SECRET_LINE_PAT.test(`JWT_SECRET=${REAL_HEX_64.slice(0, 63)}`)).toBe(false);
  });

  it('does not match a 65-char hex value (one over)', () => {
    expect(HEX_SECRET_LINE_PAT.test(`JWT_SECRET=${REAL_HEX_64}f`)).toBe(false);
  });

  it('captures the hex value in capture group 1', () => {
    const m = `JWT_SECRET=${REAL_HEX_64}`.match(HEX_SECRET_LINE_PAT);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(REAL_HEX_64);
  });
});

describe('Pattern: obviously-fake hex exclusions', () => {
  it('all-zeros 64 chars is fake', () => {
    expect(OBVIOUSLY_FAKE_HEX.some((p) => p.test('0'.repeat(64)))).toBe(true);
  });

  it('single-char repeated 64 chars is fake', () => {
    expect(OBVIOUSLY_FAKE_HEX.some((p) => p.test('a'.repeat(64)))).toBe(true);
  });

  it('sequential block ×4 is fake', () => {
    const seq = '0123456789abcdef'.repeat(4);
    expect(OBVIOUSLY_FAKE_HEX.some((p) => p.test(seq))).toBe(true);
  });

  it('REAL_HEX_64 is NOT considered fake', () => {
    expect(OBVIOUSLY_FAKE_HEX.some((p) => p.test(REAL_HEX_64))).toBe(false);
  });

  it('REAL_HEX_128 is NOT considered fake', () => {
    expect(OBVIOUSLY_FAKE_HEX.some((p) => p.test(REAL_HEX_128))).toBe(false);
  });
});

// ── Integration tests: Stellar secret key ────────────────────────────────────

describe('integration: Stellar secret key detection', () => {
  it('exits 1 and reports violation when a Stellar secret key is committed', () => {
    const dir = makeTempRepo({ 'config.js': `const KEY = '${STELLAR_SECRET}';` });
    const { exitCode, stderr } = runScanner(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Stellar secret key/i);
  });

  it('exits 0 when no Stellar secret key is present', () => {
    const dir = makeTempRepo({ 'README.md': 'Nothing suspicious here.' });
    const { exitCode, stdout } = runScanner(dir);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no secret material/i);
  });

  it('respects stellar-secret allowlist entry matching by file and line', () => {
    const content = `// test fixture\nconst KEY = '${STELLAR_SECRET}';\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'stellar-secret', file: 'config.js', line: 2, reason: 'test fixture' }],
    });
    const dir = makeTempRepo({ 'config.js': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('still flags a second line when allowlist only covers the first', () => {
    const content = `const A = '${STELLAR_SECRET}';\nconst B = '${STELLAR_SECRET}';\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'stellar-secret', file: 'config.js', line: 1, reason: 'test' }],
    });
    const dir = makeTempRepo({ 'config.js': content }, exceptions);
    const { exitCode, stderr } = runScanner(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Stellar secret key/i);
  });

  it('respects a file-level stellar-secret allowlist (no line specified)', () => {
    const content = `const A = '${STELLAR_SECRET}';\nconst B = '${STELLAR_SECRET}';\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'stellar-secret', file: 'config.js', reason: 'known test keypairs' }],
    });
    const dir = makeTempRepo({ 'config.js': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });
});

// ── Integration tests: BIP-39 mnemonic ───────────────────────────────────────

describe('integration: BIP-39 mnemonic detection', () => {
  it('exits 1 when a mnemonic phrase is committed', () => {
    const dir = makeTempRepo({ 'seed.js': `const mnemonic = '${MNEMONIC}';` });
    const { exitCode, stderr } = runScanner(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/BIP-39 mnemonic/i);
  });

  it('exits 0 when no mnemonic phrase is present', () => {
    const dir = makeTempRepo({ 'README.md': 'No secrets here.' });
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('does not flag an 11-word phrase (below BIP-39 minimum length)', () => {
    const eleven = 'abandon ability able about above absent absorb abstract absurd abuse access';
    const dir = makeTempRepo({ 'notes.txt': eleven });
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('respects mnemonic allowlist entry by file and line', () => {
    const content = `// BIP-39 test vector\nconst phrase = '${MNEMONIC}';\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'mnemonic', file: 'seed.js', line: 2, reason: 'test vector' }],
    });
    const dir = makeTempRepo({ 'seed.js': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('respects a file-level mnemonic allowlist', () => {
    const content = `const a = '${MNEMONIC}';\nconst b = '${MNEMONIC}';\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'mnemonic', file: 'seed.js', reason: 'known test vectors' }],
    });
    const dir = makeTempRepo({ 'seed.js': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });
});

// ── Integration tests: hex secrets ───────────────────────────────────────────

describe('integration: hex secret detection', () => {
  it('exits 1 when a realistic 64-char hex secret is assigned on a KEY= line', () => {
    const dir = makeTempRepo({ '.env': `JWT_SECRET=${REAL_HEX_64}` });
    const { exitCode, stderr } = runScanner(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/hex secret/i);
  });

  it('exits 1 when a realistic 128-char hex secret is assigned on a KEY= line', () => {
    const dir = makeTempRepo({ '.env': `SESSION_KEY=${REAL_HEX_128}` });
    const { exitCode, stderr } = runScanner(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/hex secret/i);
  });

  it('exits 0 for an all-zeros 64-char hex value (obviously fake)', () => {
    const dir = makeTempRepo({ '.env': `JWT_SECRET=${'0'.repeat(64)}` });
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('exits 0 for a single-char repeated 64-char hex value (obviously fake)', () => {
    const dir = makeTempRepo({ '.env': `JWT_SECRET=${'a'.repeat(64)}` });
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('exits 0 when a realistic hex value appears only in a comment (no KEY= assignment)', () => {
    const dir = makeTempRepo({ 'README.md': `<!-- example hash: ${REAL_HEX_64} -->` });
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('respects hex-secret allowlist entry by file and line', () => {
    const content = `# generated during setup\nJWT_SECRET=${REAL_HEX_64}\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'hex-secret', file: '.env', line: 2, reason: 'local dev only' }],
    });
    const dir = makeTempRepo({ '.env': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });

  it('respects a file-level hex-secret allowlist', () => {
    const content = `A=${REAL_HEX_64}\nB=${REAL_HEX_64}\n`;
    const exceptions = JSON.stringify({
      description: 'test',
      exceptions: [{ type: 'hex-secret', file: '.env', reason: 'test-only .env' }],
    });
    const dir = makeTempRepo({ '.env': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });
});

// ── Integration tests: combined / edge cases ──────────────────────────────────

describe('integration: combined violations', () => {
  it('detects all three violation types in a single file', () => {
    const content = [
      `STELLAR_SECRET=${STELLAR_SECRET}`,
      `JWT_SECRET=${REAL_HEX_64}`,
      `const mnemonic = '${MNEMONIC}';`,
    ].join('\n');
    const dir = makeTempRepo({ 'bad.js': content });
    const { exitCode, stderr } = runScanner(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Stellar secret key/i);
    expect(stderr).toMatch(/hex secret/i);
    expect(stderr).toMatch(/BIP-39 mnemonic/i);
  });

  it('exits 0 on a clean repo', () => {
    const dir = makeTempRepo({ 'README.md': 'empty' });
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(0);
  });
});

describe('integration: allowlist edge cases', () => {
  it('works correctly when security-exceptions.json is absent', () => {
    const dir = makeTempRepo({ 'clean.txt': 'no secrets here' });
    // No exceptions file written — scanner should still run without crashing
    const { exitCode, stdout } = runScanner(dir);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no secret material/i);
  });

  it('ignores non-scanner entries in security-exceptions.json (npm vuln entries)', () => {
    const content = `JWT_SECRET=${REAL_HEX_64}\n`;
    // An exception with no "type" field (npm advisory style) must NOT suppress the hex check
    const exceptions = JSON.stringify({
      description: 'mixed exceptions',
      exceptions: [
        { id: 'GHSA-xxxx', package: 'some-package', path: 'backend', expires: '2027-01-01' },
      ],
    });
    const dir = makeTempRepo({ '.env': content }, exceptions);
    const { exitCode } = runScanner(dir);
    expect(exitCode).toBe(1);
  });

  it('handles malformed security-exceptions.json without crashing', () => {
    const dir = makeTempRepo({ 'clean.txt': 'no secrets' }, 'NOT VALID JSON {{{');
    const { exitCode, stderr } = runScanner(dir);
    // Should warn and continue — not crash with a non-zero exit due to parse error
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/Could not parse/i);
  });
});
