'use strict';

/**
 * Memo Extractor
 * 
 * Handles extraction and decoding of memo fields from Stellar transactions.
 * Supports all standard Stellar memo types: TEXT, ID, HASH, RETURN.
 */

const logger = require('../../utils/logger').child('MemoExtractor');
const { decodeMemoToCanonical } = require('../../utils/stellarMemo');

/**
 * Extract memo from transaction, handling all Stellar memo types
 * @param {object} tx - Stellar transaction object
 * @returns {ExtractedMemo} Processed memo with type and content
 */
function extractMemo(tx) {
  try {
    // Handle missing memo
    if (!tx.memo || tx.memo === '') {
      return {
        content: null,
        type: null,
        raw: null,
        encoding: null
      };
    }

    // Handle string memo (most common case) — only MEMO_TEXT is valid
    if (typeof tx.memo === 'string') {
      const trimmedMemo = tx.memo.trim();
      return {
        content: trimmedMemo || null,
        type: 'MEMO_TEXT',
        raw: tx.memo,
        encoding: null
      };
    }

    // Handle structured memo object
    if (typeof tx.memo === 'object' && tx.memo !== null) {
      return extractByType(tx.memo);
    }

    // Fallback for unexpected memo format
    logger.warn('Unexpected memo format', { memo: tx.memo, txHash: tx.hash });
    return {
      content: null,
      type: 'UNKNOWN',
      raw: tx.memo,
      encoding: null
    };

  } catch (error) {
    logger.error('Error extracting memo', {
      error: error.message,
      memo: tx.memo,
      txHash: tx.hash
    });
    
    return {
      content: null,
      type: 'ERROR',
      raw: tx.memo,
      encoding: null
    };
  }
}

/**
 * Extract memo based on type (TEXT, ID, HASH, RETURN)
 * MEMO_TEXT, MEMO_ID and MEMO_HASH all resolve to a canonical payment
 * reference (#1118). MEMO_RETURN has no such encoding and is still rejected.
 * @param {object} memoData - Raw memo data from transaction
 * @returns {ExtractedMemo} Processed memo with type and content
 */
function extractByType(memoData) {
  const memoType = memoData.type || memoData._type;
  const memoValue = memoData.value || memoData._value;

  switch (memoType) {
    case 'text':
    case 'MEMO_TEXT':
      return {
        content: memoValue ? String(memoValue).trim() : null,
        type: 'MEMO_TEXT',
        raw: memoData,
        encoding: null
      };

    case 'id':
    case 'MEMO_ID': {
      // #1118 — decoded back to the canonical intent memo for wallets that
      // cannot send free text. Values outside our 32-bit memo space decode to
      // null rather than being truncated into a false match.
      const idContent = decodeMemoToCanonical(memoValue, 'MEMO_ID');
      if (!idContent) {
        logger.warn('MEMO_ID is not a valid payment reference', { memoValue });
      }
      return {
        content: idContent,
        type: 'MEMO_ID',
        raw: memoData,
        encoding: null
      };
    }

    case 'hash':
    case 'MEMO_HASH': {
      // #1118 — only hashes carrying our zero-padded canonical memo decode;
      // any other 32-byte value belongs to a different protocol and yields null.
      const hashContent = decodeMemoToCanonical(memoValue, 'MEMO_HASH');
      if (!hashContent) {
        logger.warn('MEMO_HASH is not a valid payment reference', { memoValue });
      }
      return {
        content: hashContent,
        type: 'MEMO_HASH',
        raw: memoData,
        encoding: 'hex'
      };
    }

    case 'return':
    case 'MEMO_RETURN':
      // MEMO_RETURN is not supported — 32-byte hash for return payments
      logger.warn('MEMO_RETURN type not supported for payment matching', { memoValue });
      return {
        content: null,
        type: 'MEMO_RETURN',
        raw: memoData,
        encoding: 'hex'
      };

    default:
      logger.warn('Unknown memo type', { memoType, memoData });
      return {
        content: null,
        type: 'UNKNOWN',
        raw: memoData,
        encoding: null
      };
  }
}

/**
 * Decode base64 or hex encoded memo content
 * @param {string} content - Encoded memo content
 * @param {string} encoding - Encoding type ('base64' or 'hex')
 * @returns {string} Decoded content
 */
function decodeMemo(content, encoding) {
  try {
    if (!content) return null;

    switch (encoding) {
      case 'base64':
        return Buffer.from(content, 'base64').toString('utf8');
      
      case 'hex':
        return Buffer.from(content, 'hex').toString('utf8');
      
      default:
        // If no encoding specified, try to detect and decode
        if (isBase64(content)) {
          return Buffer.from(content, 'base64').toString('utf8');
        }
        if (isHex(content)) {
          return Buffer.from(content, 'hex').toString('utf8');
        }
        // Return as-is if no encoding detected
        return content;
    }
  } catch (error) {
    logger.warn('Failed to decode memo', { content, encoding, error: error.message });
    return content; // Return original content if decoding fails
  }
}

/**
 * Check if string is valid base64
 * @param {string} str - String to check
 * @returns {boolean} True if valid base64
 */
function isBase64(str) {
  try {
    return Buffer.from(str, 'base64').toString('base64') === str;
  } catch {
    return false;
  }
}

/**
 * Check if string is valid hex
 * @param {string} str - String to check
 * @returns {boolean} True if valid hex
 */
function isHex(str) {
  return /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0;
}

module.exports = {
  extractMemo,
  extractByType,
  decodeMemo
};