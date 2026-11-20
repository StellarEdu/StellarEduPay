'use strict';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively checks a value for keys that could be used for NoSQL injection
 * or prototype pollution.
 *
 * Rejects:
 *  - keys starting with '$' (MongoDB operators)
 *  - keys containing '.' (MongoDB dotted paths)
 *  - prototype pollution keys (__proto__, constructor, prototype)
 *
 * @param {*} value - the value to inspect
 * @returns {boolean} true if the value is safe, false otherwise
 */
function isSafe(value) {
  if (value === null || typeof value !== 'object') {
    return true;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isSafe(item)) {
        return false;
      }
    }
    return true;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return false;
    }
    if (key.startsWith('$') || key.includes('.')) {
      return false;
    }
    if (!isSafe(value[key])) {
      return false;
    }
  }

  return true;
}

/**
 * Express middleware that rejects requests whose body, query or params
 * contain MongoDB operator keys, dotted keys, or prototype pollution keys.
 *
 * Mount globally after express.json() and keep the query parser as 'simple'.
 */
function sanitizeInput(req, res, next) {
  if (
    !isSafe(req.body) ||
    !isSafe(req.query) ||
    !isSafe(req.params)
  ) {
    return res.status(400).json({
      error: 'Invalid input',
      code: 'INVALID_INPUT',
    });
  }

  return next();
}

module.exports = sanitizeInput;