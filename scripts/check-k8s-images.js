#!/usr/bin/env node
'use strict';

/**
 * check-k8s-images.js — guard the image references in deploy/ (issue #1927).
 *
 * Rules:
 *   1. No reference to a personal/foreign registry namespace (e.g. mystery-cli)
 *      and no Docker Hub "stellaredupay/..." names. Those names are not
 *      published by this project's workflows.
 *   2. Every application image used by a manifest or overlay is the canonical
 *      ghcr.io/stellaredu/stellaredupay-{backend,frontend,backup-tools} image.
 *      The only other images allowed are the explicit upstream allow-list.
 *   3. The Kyverno verifyImages patterns match exactly the application images
 *      the manifests use, so the signature policy covers every deployed image.
 *
 * Usage: node scripts/check-k8s-images.js [repoRoot]
 * Exits non-zero with one line per violation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const DEPLOY = path.join(ROOT, 'deploy');

const CANONICAL_PREFIX = 'ghcr.io/stellaredu/';
const APP_IMAGES = ['stellaredupay-backend', 'stellaredupay-frontend', 'stellaredupay-backup-tools'];
const UPSTREAM_ALLOW_LIST = new Set(['mongo:7', 'redis:7-alpine']);
const FORBIDDEN_RE = /mystery-cli|stellaredupay\/(backend|frontend|backup-tools)\b/i;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ya?ml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Strip a trailing :tag or @digest so the repository name can be compared.
function repoOf(ref) {
  return ref.replace(/@sha256:[0-9a-f]+$/, '').replace(/:[^/:]+$/, '');
}

function unquote(v) {
  return v.trim().replace(/^["']|["']$/g, '');
}

const violations = [];
const usedRepos = new Set();
const policyRepos = new Set();

for (const file of walk(DEPLOY)) {
  const rel = path.relative(ROOT, file);
  const isPolicy = rel.includes(`${path.sep}policies${path.sep}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (line.startsWith('#')) return; // comments are documentation, not references
    const where = `${rel}:${idx + 1}`;

    if (FORBIDDEN_RE.test(line)) {
      violations.push(`${where}: forbidden image namespace (${line})`);
    }

    // Manifest and Kustomize image references.
    const m = line.match(/^(?:-\s*)?(image|newName|name):\s*(\S.*)$/);
    // `name:` is only an image reference inside a kustomize images: entry, so
    // require an image-like value; ordinary metadata names are ignored.
    if (m && (m[1] !== 'name' || /^(ghcr\.io\/|stellaredupay\/)/.test(unquote(m[2])))) {
      const ref = unquote(m[2]);
      if (UPSTREAM_ALLOW_LIST.has(ref)) return;
      if (!ref.startsWith(CANONICAL_PREFIX)) {
        violations.push(`${where}: image "${ref}" is not under ${CANONICAL_PREFIX} or the upstream allow-list`);
        return;
      }
      const repo = repoOf(ref);
      const name = repo.slice(CANONICAL_PREFIX.length);
      if (!APP_IMAGES.includes(name)) {
        violations.push(`${where}: "${ref}" is not a published StellarEduPay image`);
        return;
      }
      (isPolicy ? policyRepos : usedRepos).add(repo);
      return;
    }

    // Kyverno verifyImages patterns, e.g. - "ghcr.io/stellaredu/stellaredupay-backend:*"
    const p = line.match(/^-\s*"([^"]+)"$/);
    if (isPolicy && p && p[1].startsWith('ghcr.io/')) {
      const pattern = p[1];
      const repo = pattern.replace(/:\*$/, '');
      if (!repo.startsWith(CANONICAL_PREFIX)) {
        violations.push(`${where}: policy pattern "${pattern}" is not under ${CANONICAL_PREFIX}`);
      } else {
        policyRepos.add(repo);
      }
    }
  });
}

if (usedRepos.size === 0) {
  violations.push('no StellarEduPay image references found under deploy/ (check the scan is correct)');
}

const missingFromPolicy = [...usedRepos].filter((r) => !policyRepos.has(r));
const notUsedByManifests = [...policyRepos].filter((r) => !usedRepos.has(r));
for (const r of missingFromPolicy) violations.push(`Kyverno policy does not verify manifest image ${r}`);
for (const r of notUsedByManifests) violations.push(`Kyverno policy verifies ${r}, which no manifest uses`);

if (violations.length > 0) {
  for (const v of violations) console.error(`❌  ${v}`);
  console.error(`\n${violations.length} image reference violation(s).`);
  process.exit(1);
}

console.log(`✅  ${usedRepos.size} application image(s) under deploy/ use ${CANONICAL_PREFIX}; policy matches them exactly.`);
