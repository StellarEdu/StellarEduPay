/**
 * Strips HTML tags from user-entered text.
 *
 * Defense-in-depth for text inputs whose values may later be rendered in a
 * context that isn't auto-escaped (e.g. issue #1391 — the previously-fixed
 * stored XSS in the unsubscribe page, see tests/unsubscribe-xss.test.js).
 * The backend is the authoritative boundary; this only prevents markup from
 * ever reaching the form's own state in the first place.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripHtml(value) {
  if (typeof value !== "string") return value;
  return value.replace(/<[^>]*>/g, "");
}
