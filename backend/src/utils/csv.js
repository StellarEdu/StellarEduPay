'use strict';

/**
 * Shared CSV helpers (Issue #1544).
 *
 * Every CSV produced by the API must go through csvEscape so that cells are
 * both RFC 4180-safe and neutralised against spreadsheet formula injection
 * (CWE-1236).
 */

const { Transform } = require('stream');

// Characters that make Excel / LibreOffice / Google Sheets treat a cell as a
// formula (or, for tab/CR, allow a formula to be smuggled past the check).
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Escape a single CSV field value per RFC 4180.
 * Wraps in double-quotes when the value contains a comma, double-quote, CR or LF.
 * Internal double-quotes are doubled ("").
 * Leading formula-injection characters (=, +, -, @, tab, CR) are prefixed with
 * a single-quote so spreadsheet apps do not evaluate them as formulas.
 *
 * @param {*} value
 * @returns {string}
 */
function csvEscape(value) {
  let str = String(value ?? '');
  if (FORMULA_TRIGGER.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build one CSV row from an array of values.
 * @param {Array<*>} values
 * @returns {string}
 */
function csvRow(values) {
  return values.map(csvEscape).join(',');
}

/**
 * Build a Transform stream that turns a stream of documents into CSV lines.
 *
 * The transform is object-mode on the writable side (Mongo cursors emit plain
 * objects) and byte-mode on the readable side, so it can be piped straight
 * into an HTTP response. Using a Transform (rather than a `data` listener)
 * lets `stream.pipeline` apply backpressure end-to-end and destroy the source
 * cursor when the destination closes early (Issue #1611).
 *
 * @param {(doc: *) => Array<*>} toRow maps a document to an array of cells
 * @param {string[]} [header] optional header row written before any document
 * @returns {Transform}
 */
function csvTransform(toRow, header) {
  let wroteHeader = false;
  return new Transform({
    writableObjectMode: true,
    transform(doc, _encoding, callback) {
      try {
        let line = '';
        if (!wroteHeader && Array.isArray(header)) {
          wroteHeader = true;
          line += csvRow(header) + '\n';
        }
        line += csvRow(toRow(doc)) + '\n';
        callback(null, line);
      } catch (err) {
        callback(err);
      }
    },
  });
}

module.exports = { csvEscape, csvRow, csvTransform, FORMULA_TRIGGER };
