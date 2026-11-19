#!/usr/bin/env node
'use strict';

/**
 * Kubernetes Ingress TLS check (issue #1923).
 *
 * Every Ingress manifest must:
 *   - declare a non-empty spec.tls block, each entry with a secretName;
 *   - give every rule an explicit host;
 *   - cover every rule host with some spec.tls[].hosts entry. A wildcard entry
 *     such as "*.example.com" covers exactly one label below it.
 *
 * Usage:
 *   node scripts/check-ingress-tls.js                 # deploy/k8s/ingress.yaml
 *   node scripts/check-ingress-tls.js path/to/a.yaml  # explicit files
 *
 * Needs js-yaml. Resolved through NODE_PATH, or from this repo's node_modules.
 * CI installs a pinned copy outside the repo (see .github/workflows/ci.yml).
 *
 * Exit code 0 when every Ingress passes. 1 when any fails, or when a file
 * contains no Ingress at all.
 */

const fs = require('fs');
const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch (err) {
  console.error('check-ingress-tls: js-yaml is not available. Install it or set NODE_PATH.');
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = [path.join(REPO_ROOT, 'deploy', 'k8s', 'ingress.yaml')];

function hostCovered(host, tlsHosts) {
  for (const tlsHost of tlsHosts) {
    if (tlsHost === host) return true;
    if (tlsHost.startsWith('*.')) {
      const suffix = tlsHost.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) {
        const label = host.slice(0, host.length - suffix.length);
        if (!label.includes('.')) return true;
      }
    }
  }
  return false;
}

/**
 * @param {object} ingress  a parsed Ingress document
 * @returns {string[]} problems found (empty when the Ingress passes)
 */
function checkIngress(ingress) {
  const problems = [];
  const name = (ingress.metadata && ingress.metadata.name) || '(unnamed)';
  const spec = ingress.spec || {};

  const tls = Array.isArray(spec.tls) ? spec.tls : [];
  if (tls.length === 0) {
    problems.push(`Ingress "${name}" has no spec.tls block`);
  }

  const tlsHosts = [];
  for (const entry of tls) {
    if (!entry || !entry.secretName) {
      problems.push(`Ingress "${name}" has a spec.tls entry without secretName`);
    }
    const hosts = Array.isArray(entry && entry.hosts) ? entry.hosts : [];
    if (hosts.length === 0) {
      problems.push(`Ingress "${name}" has a spec.tls entry with no hosts`);
    }
    tlsHosts.push(...hosts.filter((h) => typeof h === 'string' && h.length > 0));
  }

  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  if (rules.length === 0) {
    problems.push(`Ingress "${name}" has no spec.rules`);
  }
  for (const rule of rules) {
    const host = rule && rule.host;
    if (!host) {
      problems.push(`Ingress "${name}" has a rule without a host, so TLS coverage cannot be verified`);
      continue;
    }
    if (tlsHosts.length > 0 && !hostCovered(host, tlsHosts)) {
      problems.push(`Ingress "${name}" rule host "${host}" is not covered by spec.tls hosts [${tlsHosts.join(', ')}]`);
    }
  }

  return problems;
}

function ingressDocs(file) {
  const text = fs.readFileSync(file, 'utf8');
  return yaml.loadAll(text).filter((doc) => doc && doc.kind === 'Ingress');
}

function main(argv) {
  const files = argv.length > 0 ? argv.map((f) => path.resolve(f)) : DEFAULT_FILES;
  let failures = 0;
  let checked = 0;

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    if (!fs.existsSync(file)) {
      console.error(`::error file=${rel}::file not found`);
      failures += 1;
      continue;
    }
    const docs = ingressDocs(file);
    if (docs.length === 0) {
      console.error(`::error file=${rel}::no Ingress object found`);
      failures += 1;
      continue;
    }
    for (const doc of docs) {
      checked += 1;
      for (const problem of checkIngress(doc)) {
        failures += 1;
        console.error(`::error file=${rel}::${problem}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`check-ingress-tls: ${failures} problem(s) across ${checked} Ingress object(s)`);
    return 1;
  }
  console.log(`check-ingress-tls: ${checked} Ingress object(s) have TLS covering every rule host`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { checkIngress, hostCovered };
