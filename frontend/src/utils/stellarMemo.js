/**
 * Stellar memo encoding helpers (SEP-0007).
 *
 * Payment intent memos are 8 uppercase hex characters (4 random bytes, see
 * createPaymentIntent). That representation is small enough to round-trip
 * losslessly through all three memo types we support:
 *
 *   MEMO_TEXT — the canonical form, sent verbatim ("A3F91B2C")
 *   MEMO_ID   — the same 32-bit value as an unsigned decimal ("2750749484")
 *   MEMO_HASH — the value right-aligned in 32 bytes, base64-encoded per SEP-0007
 *
 * Every encoding is reversible back to the canonical text form, so the backend
 * can normalise an incoming memo of any type and match it against the intent
 * without a second lookup path.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

export const MEMO_TYPES = ['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH'];

/** Canonical intent memos: exactly 8 hex characters. */
const CANONICAL_MEMO_RE = /^[0-9A-F]{8}$/;

/**
 * Normalise a memo type to its SEP-0007 spelling.
 * Accepts the short forms ('text', 'id', 'hash') the codebase used previously.
 *
 * @param {string} memoType
 * @returns {string} One of MEMO_TEXT, MEMO_ID, MEMO_HASH
 */
export function normalizeMemoType(memoType) {
  if (!memoType) return 'MEMO_TEXT';
  const upper = String(memoType).toUpperCase();
  const full = upper.startsWith('MEMO_') ? upper : `MEMO_${upper}`;
  if (!MEMO_TYPES.includes(full)) {
    throw new Error(
      `Unsupported memo type '${memoType}'. Supported types: ${MEMO_TYPES.join(', ')}`,
    );
  }
  return full;
}

/**
 * True when `memo` is a canonical 8-hex-character payment intent memo.
 * Only canonical memos can be re-encoded as MEMO_ID or MEMO_HASH — a
 * free-text memo (e.g. a raw student ID) has no numeric equivalent.
 *
 * @param {string} memo
 * @returns {boolean}
 */
export function isEncodableMemo(memo) {
  return typeof memo === 'string' && CANONICAL_MEMO_RE.test(memo.trim().toUpperCase());
}

/**
 * Encode a canonical memo into the wire form for the given memo type.
 *
 * @param {string} memo - Canonical 8-hex-character memo
 * @param {string} memoType - SEP-0007 memo type
 * @returns {string} Wire-form memo value
 * @throws {Error} If the memo cannot be represented in the requested type
 */
export function encodeMemo(memo, memoType) {
  const type = normalizeMemoType(memoType);
  const value = String(memo).trim().toUpperCase();

  if (type === 'MEMO_TEXT') {
    // Text memos are sent verbatim and are capped at 28 bytes on-chain.
    const byteLength = new TextEncoder().encode(memo).length;
    if (byteLength > 28) {
      throw new Error(`MEMO_TEXT exceeds the 28-byte Stellar limit (got ${byteLength} bytes)`);
    }
    return String(memo);
  }

  if (!isEncodableMemo(value)) {
    throw new Error(
      `Memo '${memo}' cannot be encoded as ${type} — only canonical 8-hex-character ` +
        'payment intent memos have a numeric equivalent. Use MEMO_TEXT instead.',
    );
  }

  if (type === 'MEMO_ID') {
    // uint64 on the wire; our 32-bit value always fits.
    return String(parseInt(value, 16));
  }

  // MEMO_HASH — 32 raw bytes, base64 per SEP-0007. Right-align the 4 memo bytes
  // so the encoding is deterministic and zero-padding is unambiguous.
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    bytes[28 + i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

/**
 * Reverse `encodeMemo` — recover the canonical memo from any supported type.
 * Returns null when the value is not a valid encoding of a canonical memo, so
 * callers can fall through to their existing unmatched-payment handling.
 *
 * @param {string} value - Wire-form memo value
 * @param {string} memoType - SEP-0007 memo type
 * @returns {string|null} Canonical 8-hex-character memo, or null
 */
export function decodeMemo(value, memoType) {
  if (value === null || value === undefined || value === '') return null;

  let type;
  try {
    type = normalizeMemoType(memoType);
  } catch {
    return null;
  }

  if (type === 'MEMO_TEXT') {
    const text = String(value).trim();
    return text || null;
  }

  if (type === 'MEMO_ID') {
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return null;
    const numeric = Number(raw);
    // Reject anything outside the 32-bit space our memos occupy rather than
    // truncating a wallet's unrelated account identifier into a false match.
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffffffff) return null;
    return numeric.toString(16).toUpperCase().padStart(8, '0');
  }

  // MEMO_HASH — accept base64 (SEP-0007 wire form) or hex (Horizon's JSON form).
  const bytes = decodeHashBytes(String(value).trim());
  if (!bytes || bytes.length !== 32) return null;
  // The first 28 bytes must be the zero padding we wrote, otherwise this hash
  // is someone else's 32-byte value and must not be matched.
  for (let i = 0; i < 28; i += 1) {
    if (bytes[i] !== 0) return null;
  }
  return Array.from(bytes.slice(28))
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

function decodeHashBytes(value) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  try {
    const binary = base64ToBinary(value);
    if (binary === null) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBinary(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (typeof atob === 'function') return atob(value);
  return Buffer.from(value, 'base64').toString('binary');
}
