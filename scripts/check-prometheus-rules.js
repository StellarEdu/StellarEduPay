#!/usr/bin/env node
'use strict';

/**
 * Prometheus rule-file coverage check (#2016)
 *
 * monitoring/prometheus.yml used to list alert files by hand, so three files
 * (admin-alerts.yml, heap_usage.yml, payment_processing_latency.yml) were
 * never loaded and their alerts never fired. This script fails when any
 * *.yml file in monitoring/alerts/ is not matched by the rule_files globs in
 * monitoring/prometheus.yml, and when a glob matches nothing.
 *
 * Usage: node scripts/check-prometheus-rules.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'monitoring/prometheus.yml');
const ALERTS_DIR = path.join(ROOT, 'monitoring/alerts');

/** Extract the rule_files entries from prometheus.yml (simple YAML subset). */
function readRuleFiles(configText) {
  const lines = configText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^rule_files:\s*$/.test(line));
  if (start === -1) {
    throw new Error('monitoring/prometheus.yml has no rule_files block');
  }

  const entries = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/);
    if (!match) break;
    entries.push(match[1].trim());
  }

  if (entries.length === 0) {
    throw new Error('monitoring/prometheus.yml rule_files is empty');
  }
  return entries;
}

/** Convert a Prometheus glob (only `*` is used here) into a RegExp. */
function globToRegExp(glob) {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

function main() {
  const configText = fs.readFileSync(CONFIG_PATH, 'utf8');
  const ruleFiles = readRuleFiles(configText);

  const alertFiles = fs
    .readdirSync(ALERTS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  const patterns = ruleFiles.map((entry) => ({
    entry,
    regex: globToRegExp(entry),
  }));

  const errors = [];

  for (const { entry, regex } of patterns) {
    const matched = alertFiles.filter((name) => regex.test(`alerts/${name}`));
    if (matched.length === 0) {
      errors.push(`rule_files entry "${entry}" matches no file in monitoring/alerts/`);
    }
  }

  for (const name of alertFiles) {
    const loaded = patterns.some(({ regex }) => regex.test(`alerts/${name}`));
    if (!loaded) {
      errors.push(`monitoring/alerts/${name} is not loaded by rule_files`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    console.error(
      `\n${errors.length} problem(s) found. Load every alert file, e.g. rule_files: ["alerts/*.yml"].`
    );
    process.exit(1);
  }

  console.log(
    `All ${alertFiles.length} alert rule files in monitoring/alerts/ are loaded by rule_files.`
  );
}

main();
