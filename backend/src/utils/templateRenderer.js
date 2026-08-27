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
const { t, translations } = require('../services/i18n');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const _cache = new Map();

/**
 * Build `{{i18n_<key>}}` vars for every key in the given locale's translation
 * dict. Unsupported locales fall back to English (handled by `t()` itself).
 */
function buildI18nVars(locale) {
  const out = {};
  for (const key of Object.keys(translations.en)) {
    out[`i18n_${key}`] = t(locale, key);
  }
  return out;
}

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
 * When `vars.locale` is set, `{{i18n_<key>}}` placeholders are populated from
 * the matching locale's translations (falling back to English for an
 * unsupported locale or a missing key).
 * @returns {{text: string, html: string}}
 */
function renderEmailTemplate(name, vars, opts = {}) {
  const merged = { ...buildI18nVars(vars.locale || 'en'), ...vars };
  return {
    text: renderTemplate(loadTemplate(`${name}.txt`, opts), merged),
    html: renderTemplate(loadTemplate(`${name}.html`, opts), merged),
  };
}

module.exports = { loadTemplate, renderTemplate, renderEmailTemplate, TEMPLATES_DIR };
