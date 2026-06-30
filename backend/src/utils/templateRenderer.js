'use strict';

/**
 * Minimal external-template loader and renderer shared by the email services
 * (Issue #80 — "Templates externalized and tested").
 *
 * Templates live under backend/src/templates/. Supported syntax:
 *   {{key}}                       — substituted with vars[key] ('' when nullish)
 *   {{#if key}}…{{/if}}           — block included only when vars[key] is truthy
 *
 * Loaded template files are cached in-process; pass `fresh: true` to bypass the
 * cache (used in tests).
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const _cache = new Map();

function loadTemplate(filename, { fresh = false } = {}) {
  if (!fresh && _cache.has(filename)) return _cache.get(filename);
  const contents = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
  _cache.set(filename, contents);
  return contents;
}

function renderTemplate(template, vars = {}) {
  const withConditionals = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, inner) => (vars[key] ? inner : '')
  );
  return withConditionals.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

/**
 * Load `name.txt` and `name.html` and render both with the same vars.
 * @returns {{text: string, html: string}}
 */
function renderEmailTemplate(name, vars, opts = {}) {
  return {
    text: renderTemplate(loadTemplate(`${name}.txt`, opts), vars),
    html: renderTemplate(loadTemplate(`${name}.html`, opts), vars),
  };
}

module.exports = { loadTemplate, renderTemplate, renderEmailTemplate, TEMPLATES_DIR };
