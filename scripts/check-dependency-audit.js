#!/usr/bin/env node
'use strict';

/**
 * Fails if `npm audit` reports a high/critical advisory in <package-path> that
 * has no matching, non-expired entry in security-exceptions.json.
 *
 * Usage: node scripts/check-dependency-audit.js <package-path>
 *   e.g. node scripts/check-dependency-audit.js .
 *        node scripts/check-dependency-audit.js backend
 *        node scripts/check-dependency-audit.js frontend
 *
 * See docs/dependency-triage.md for the exception process.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GATED_SEVERITIES = ['high', 'critical'];

function findUnexceptedVulnerabilities(vulnerabilities, exceptions, packagePath, today) {
  const failures = [];
  for (const vuln of Object.values(vulnerabilities)) {
    if (!GATED_SEVERITIES.includes(vuln.severity)) continue;

    const advisoryIds = (vuln.via || [])
      .filter((entry) => typeof entry === 'object' && entry.url)
      .map((entry) => entry.url.split('/').pop());

    // Entries whose `via` is only package names (no advisory objects) are
    // transitive-only; the direct dependency carries its own advisory entry.
    if (advisoryIds.length === 0) continue;

    const hasCurrentException = advisoryIds.some((id) =>
      exceptions.some(
        (ex) =>
          ex.path === packagePath &&
          ex.package === vuln.name &&
          ex.id === id &&
          ex.expires >= today
      )
    );

    if (!hasCurrentException) {
      failures.push({ package: vuln.name, severity: vuln.severity, advisoryIds });
    }
  }
  return failures;
}

function main() {
  const packagePath = process.argv[2];
  if (!packagePath) {
    console.error('Usage: node scripts/check-dependency-audit.js <package-path>');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..');
  const exceptions = loadExceptions(repoRoot);
  const vulnerabilities = runAudit(path.join(repoRoot, packagePath));
  const today = new Date().toISOString().slice(0, 10);
  const failures = findUnexceptedVulnerabilities(vulnerabilities, exceptions, packagePath, today);

  if (failures.length > 0) {
    console.error(
      `\nDependency audit failed for "${packagePath}": ${failures.length} high/critical advisory(ies) with no current exception.\n`
    );
    for (const failure of failures) {
      console.error(`  - ${failure.package} (${failure.severity}): ${failure.advisoryIds.join(', ')}`);
    }
    console.error(
      '\nRun `npm audit fix` to patch, or add a dated, time-bound entry to security-exceptions.json ' +
        '(existing exceptions expire and must be renewed). See docs/dependency-triage.md.\n'
    );
    process.exit(1);
  }

  console.log(`Dependency audit OK for "${packagePath}" (no unexcepted high/critical advisories).`);
}

function loadExceptions(repoRoot) {
  const file = path.join(repoRoot, 'security-exceptions.json');
  const { exceptions } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return exceptions;
}

function runAudit(cwd) {
  let stdout;
  try {
    // npm audit exits non-zero as soon as any advisory is found, but still
    // writes the full JSON report to stdout — capture it from the error too.
    stdout = execSync('npm audit --json', { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (err) {
    stdout = err.stdout;
  }
  const report = JSON.parse(stdout);
  return report.vulnerabilities || {};
}

if (require.main === module) {
  main();
}

module.exports = { findUnexceptedVulnerabilities };
