/**
 * Stellar transaction hash validator and utilities.
 *
 * A Stellar transaction hash is the SHA-256 hash of the transaction envelope,
 * represented as a 64-character hexadecimal string.
 */

export const STELLAR_TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Validate a Stellar transaction hash.
 *
 * @param {string} hash - The transaction hash to validate
 * @returns {{ valid: boolean, error: string | null, code: string | null, normalized?: string }}
 */
export function validateStellarTxHash(hash) {
  const raw = String(hash ?? "").trim();

  if (!raw) {
    return {
      valid: false,
      error: "Transaction hash is required",
      code: "REQUIRED",
    };
  }

  if (raw.length !== 64) {
    return {
      valid: false,
      error: "Transaction hash must be exactly 64 hexadecimal characters",
      code: "INVALID_LENGTH",
    };
  }

  if (!STELLAR_TX_HASH_RE.test(raw)) {
    return {
      valid: false,
      error: "Transaction hash must contain only hexadecimal characters (0-9, a-f)",
      code: "INVALID_FORMAT",
    };
  }

  return {
    valid: true,
    error: null,
    code: null,
    normalized: raw.toLowerCase(),
  };
}

/**
 * Convenience check returning true only if hash is a valid 64-char hex string.
 *
 * @param {string} hash
 * @returns {boolean}
 */
export function isValidStellarTxHash(hash) {
  return validateStellarTxHash(hash).valid;
}

export const isStellarTxHash = isValidStellarTxHash;
