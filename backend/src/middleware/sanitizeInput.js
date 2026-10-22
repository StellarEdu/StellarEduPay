/**
 * Issue #1742: Reject untrusted input that contains MongoDB operator keys
 * (`$`-prefixed) or dotted keys, which could otherwise be interpreted as
 * query operators when a request value flows into a filter.
 *
 * This replaces the global `mongoose.set('sanitizeFilter', true)` flag, which
 * rewrote every internal `$ne`/`$in`/`$gte`/`$exists` filter into a literal
 * `$eq` and broke most queries in the app.
 */

const hasUnsafeKeys = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasUnsafeKeys);
  }

  return Object.keys(value).some((key) => {
    if (key.startsWith('$') || key.includes('.')) {
      return true;
    }
    return hasUnsafeKeys(value[key]);
  });
};

const sanitizeInput = (req, res, next) => {
  if (hasUnsafeKeys(req.body) || hasUnsafeKeys(req.params)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid input: operator or dotted keys are not allowed',
    });
  }

  return next();
};

module.exports = sanitizeInput;
module.exports.hasUnsafeKeys = hasUnsafeKeys;
