'use strict';

/**
 * Stellar memo decoding (SEP-0007) — backend mirror.
 *
 * MIRRORS frontend/src/utils/stellarMemo.js. The frontend encodes a payment
 * intent memo into the QR code; this module decodes whatever the wallet
 * actually broadcast back to the canonical form. The two must stay in sync —
 * any change to the encoding here needs the same change there (same
 * arrangement the stroop-precision rules use, #1123).
 *
 * Payment intent memos are 8 uppercase hex characters (4 random bytes, see
 * createPaymentIntent), which round-trips losslessly through:
 *
 *   MEMO_TEXT — canonical form, verbatim ("A3F91B2C")
 *   MEMO_ID   — the same 32-bit value as an unsigned decimal ("2750749484")
 *   MEMO_HASH — the value right-aligned in 32 bytes (base64 on the wire,
 *               hex in Horizon's JSON)
 *
 * Because every supported type decodes back to the canonical text memo, the
 * intent lookup stays a single query against `memo` — there is no second
 * matching path to keep correct.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

const SUPPORTED_MEMO_TYPES = Object.freeze(['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH']);

/** Canonical intent memos: exactly 8 hex characters. */
const CANONICAL_MEMO_RE = /^[0-9A-F]{8}$/;

/**
 * Normalise Horizon's memo type spelling ('text', 'id', 'hash') or the
 * SEP-0007 spelling ('MEMO_TEXT', …) to the SEP-0007 form.
 *
 * @param {string} memoType
 * @returns {string|null} SEP-0007 memo type, or null if unsupported
 */
function normalizeMemoType(memoType) {
  if (!memoType) return null;
  const upper = String(memoType).toUpperCase();
  const full = upper.startsWith('MEMO_') ? upper : `MEMO_${upper}`;
  return SUPPORTED_MEMO_TYPES.includes(full) ? full : null;
}

/**
 * True when `memo` is a canonical 8-hex-character payment intent memo.
 *
 * @param {string} memo
 * @returns {boolean}
 */
function isCanonicalMemo(memo) {
  return typeof memo === 'string' && CANONICAL_MEMO_RE.test(memo.trim().toUpperCase());
}

/**
 * Decode a memo of any supported type back to its canonical text form.
 *
 * Returns null when the value is not a valid encoding of a canonical memo, so
 * callers fall through to their existing unmatched-payment handling rather
 * than matching on a coincidence.
 *
 * @param {string|number} value - Memo value as reported by Horizon
 * @param {string} memoType - Memo type ('text' | 'id' | 'hash' | MEMO_* form)
 * @returns {string|null} Canonical memo, or null
 */
function decodeMemoToCanonical(value, memoType) {
  if (value === null || value === undefined || value === '') return null;

  const type = normalizeMemoType(memoType);
  if (!type) return null;

  if (type === 'MEMO_TEXT') {
    // Text memos are passed through untouched — they may legitimately be a
    // free-text memo (a raw student ID) rather than an intent memo, and the
    // caller's existing matching handles that.
    const text = String(value).trim();
    return text || null;
  }

  if (type === 'MEMO_ID') {
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return null;
    const numeric = Number(raw);
    // Reject anything outside the 32-bit space our memos occupy rather than
    // truncating an unrelated account identifier into a false match. Wallets
    // that use MEMO_ID for exchange routing send values far above this.
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffffffff) return null;
    return numeric.toString(16).toUpperCase().padStart(8, '0');
  }

  // MEMO_HASH — accept hex (Horizon JSON) or base64 (SEP-0007 wire form).
  const bytes = decodeHashBytes(String(value).trim());
  if (!bytes || bytes.length !== 32) return null;

  // The leading 28 bytes must be the zero padding the encoder wrote. Anything
  // else is a genuine 32-byte hash belonging to someone else's protocol and
  // must not be matched.
  for (let i = 0; i < 28; i += 1) {
    if (bytes[i] !== 0) return null;
  }

  const tail = bytes.subarray(28).toString('hex').toUpperCase();
  return CANONICAL_MEMO_RE.test(tail) ? tail : null;
}

function decodeHashBytes(value) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  // Buffer.from silently tolerates malformed base64; re-encoding catches it.
  return buf.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? buf : null;
}

module.exports = {
  SUPPORTED_MEMO_TYPES,
  normalizeMemoType,
  isCanonicalMemo,
  decodeMemoToCanonical,
};
