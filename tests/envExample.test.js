'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const JS_ENV_ROOTS = [
  'backend/src',
  'backend/migrations',
  'scripts',
];

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.monitoring.yml',
];

function walkJsFiles(relativeDir) {
  const dir = path.join(repoRoot, relativeDir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(path.relative(repoRoot, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectBackendEnvKeys() {
  const keys = new Set();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    // authController reads token TTL names through parseTTL(envVar, default).
    /parseTTL\(['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];

  for (const root of JS_ENV_ROOTS) {
    for (const file of walkJsFiles(root)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          keys.add(match[1]);
        }
      }
    }
  }

  return keys;
}

function collectComposeEnvKeys() {
  const keys = new Set();
  const interpolationPattern = /\$\{([A-Z][A-Z0-9_]*)(?::?[-?][^}]*)?\}/g;

  for (const relativeFile of COMPOSE_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, relativeFile), 'utf8');
    for (const match of source.matchAll(interpolationPattern)) {
      keys.add(match[1]);
    }
  }

  return keys;
}

function readExampleEntries() {
  const source = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  return source.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    return match ? [{ key: match[1], line: index + 1 }] : [];
  });
}

function duplicateEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const lines = byKey.get(entry.key) || [];
    lines.push(entry.line);
    byKey.set(entry.key, lines);
  }

  return [...byKey.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([key, lines]) => `${key} on lines ${lines.join(', ')}`)
    .sort();
}

describe('.env.example', () => {
  it('does not define duplicate active keys', () => {
    const duplicates = duplicateEntries(readExampleEntries());
    expect(duplicates).toEqual([]);
  });

  it('matches backend process.env reads and Docker Compose interpolation keys', () => {
    const expected = new Set([
      ...collectBackendEnvKeys(),
      ...collectComposeEnvKeys(),
    ]);
    const actual = new Set(readExampleEntries().map((entry) => entry.key));

    const missing = [...expected].filter((key) => !actual.has(key)).sort();
    const extra = [...actual].filter((key) => !expected.has(key)).sort();

    const message = [
      missing.length ? `Missing from .env.example:\n${missing.join('\n')}` : '',
      extra.length ? `Not read by backend code or Docker Compose:\n${extra.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    expect(message).toBe('');
  });
});
