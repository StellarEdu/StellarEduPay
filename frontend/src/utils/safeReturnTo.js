// Post-login destination check (#1951).
//
// Only same-origin, absolute in-app paths are allowed. The check runs on both the
// raw and the decoded value, because some routers decode %5C (\) and %2F%2F (//)
// before navigating. The WHATWG URL parser also treats "\" as "/", so both
// characters are rejected outright.
//
// Resolution uses a fixed base origin, so the result does not depend on the
// browser's location and the function is safe to call during SSR or in tests.

const FALLBACK = '/dashboard';
const BASE = 'https://return-to.invalid';
const BASE_ORIGIN = new URL(BASE).origin;

// Backslashes and ASCII control characters (including tab and newline, which the
// URL parser strips silently).
const UNSAFE = /[\\\u0000-\u001f\u007f]/;

function isSafeAbsolutePath(value) {
  return value.startsWith('/') && !value.startsWith('//') && !UNSAFE.test(value);
}

export function safeReturnTo(returnTo) {
  if (typeof returnTo !== 'string' || returnTo === '') return FALLBACK;
  if (!isSafeAbsolutePath(returnTo)) return FALLBACK;

  let decoded;
  try {
    decoded = decodeURIComponent(returnTo);
  } catch {
    return FALLBACK;
  }
  if (!isSafeAbsolutePath(decoded)) return FALLBACK;

  let url;
  try {
    url = new URL(returnTo, BASE);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== BASE_ORIGIN) return FALLBACK;

  return `${url.pathname}${url.search}${url.hash}`;
}

export default safeReturnTo;
