#!/usr/bin/env node

/**
 * Migration validation script.
 *
 * This enforces the repo policy that schema/data changes only happen through the
 * versioned runner in backend/migrations/, and that ad-hoc scripts in the root
 * scripts/ directory are forbidden.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(DEFAULT_REPO_ROOT, 'backend/migrations');
const ROOT_SCRIPTS_DIR = path.join(DEFAULT_REPO_ROOT, 'scripts');

const IGNORED_DIRS = new Set(['node_modules', 'coverage', '.git', 'dist', 'build', '.next']);

function validateMigrations(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || DEFAULT_REPO_ROOT);
  const migrationsDir = path.join(repoRoot, 'backend/migrations');
  const scriptsDir = path.join(repoRoot, 'scripts');

  const issues = [];
  const files = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')) : [];

  const migrations = {};
  for (const file of files) {
    const match = file.match(/^(\d{3})_(.+)\.js$/);
    if (!match) {
      if (!file.match(/^\d{3}_/)) {
        issues.push(`❌ Unnumbered migration file found: ${file}`);
      }
      continue;
    }

    const [, number] = match;
    if (migrations[number]) {
      issues.push(
        `❌ Duplicate migration number ${number}:\n` +
        `   - ${migrations[number]}\n` +
        `   - ${file}`
      );
    } else {
      migrations[number] = file;
    }
  }

  const numbers = Object.keys(migrations)
    .map(n => parseInt(n, 10))
    .sort((a, b) => a - b);

  if (numbers.length > 0) {
    const firstNum = numbers[0];
    const lastNum = numbers[numbers.length - 1];
    for (let i = firstNum; i <= lastNum; i++) {
      const padded = String(i).padStart(3, '0');
      if (!migrations[padded]) {
        issues.push(`⚠️  Gap detected: Migration ${padded} is missing`);
      }
    }
  }

  issues.push(...findDanglingMigrationReferences(repoRoot));
  issues.push(...findForbiddenMigrateScripts(scriptsDir));

  if (issues.length > 0) {
    console.error('❌ Migration validation failed!\n');
    issues.forEach(issue => console.error(issue));
    console.error('\n✅ Migration validation rules:');
    console.error('  • All migration files must be named: NNN_description.js (NNN = 3 digits)');
    console.error('  • Migration numbers must be unique');
    console.error('  • Migration numbers should be sequential (001, 002, 003, ...)');
    console.error('  • No file may require/import a migration path that does not resolve');
    console.error('  • Root scripts/migrate-* files are forbidden; only scripts/migrate.js is allowed');
    throw new Error(issues.join('\n'));
  }

  console.log(`✅ Migration validation passed! (${numbers.length} migrations found)`);
  console.log('   Migrations are properly numbered and sequenced.');
  console.log('   Ad-hoc root migrate-* scripts are not present.');
  return true;
}

function findForbiddenMigrateScripts(scriptsDir) {
  const problems = [];
  if (!fs.existsSync(scriptsDir)) return problems;

  for (const file of fs.readdirSync(scriptsDir)) {
    if (!file.endsWith('.js')) continue;
    if (file === 'migrate.js') continue;
    if (/^migrate(?:-.+)?\.js$/.test(file)) {
      problems.push(`❌ Forbidden ad-hoc migration script found in scripts/: ${file}`);
    }
  }

  return problems;
}

function findDanglingMigrationReferences(repoRoot) {
  const problems = [];
  const files = walk(repoRoot);
  const requireRe = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const importRe = /import\s+(?:[^'"`]+\s+from\s+)?['"`]([^'"`]+)['"`]/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const refs = collectRefs(content, requireRe).concat(collectRefs(content, importRe));

    for (const ref of refs) {
      if (!isMigrationRef(ref)) continue;
      if (!resolves(ref, path.dirname(file))) {
        problems.push(
          `❌ Dangling migration reference in ${path.relative(repoRoot, file)}:\n` +
          `   '${ref}' does not resolve to a migration file`
        );
      }
    }
  }

  return problems;
}

function collectRefs(content, regex) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function isMigrationRef(p) {
  if (!p.includes('migrations')) return false;
  return p.split('/').some(seg => /^\d{3}_/.test(seg));
}

function resolves(p, fromDir) {
  if (!p.startsWith('.') && !p.startsWith('/')) return true;
  const abs = path.resolve(fromDir, p);
  return (
    fs.existsSync(abs) ||
    fs.existsSync(`${abs}.js`) ||
    fs.existsSync(`${abs}.json`)
  );
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

if (require.main === module) {
  try {
    validateMigrations();
    process.exit(0);
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { validateMigrations, findDanglingMigrationReferences, findForbiddenMigrateScripts };
