'use strict';

/**
 * Outbound webhook event envelope (#1815).
 *
 * Every delivery declares the envelope version it was built with (`apiVersion`)
 * and, for endpoint-scoped deliveries, a per-endpoint `sequence` number. The
 * sequence increases monotonically for each endpoint, so a consumer can detect
 * gaps and reorder out-of-order arrivals. Retries reuse the original sequence.
 */

const WEBHOOK_API_VERSION = '2026-10-01';

/**
 * @param {object} params
 * @param {string} params.event
 * @param {string} params.timestamp  ISO-8601 time the body was built
 * @param {object} params.data       PII-filtered payload
 * @param {number|null} [params.sequence] per-endpoint sequence, null for legacy single-URL deliveries
 * @returns {object} the JSON body to serialise and sign
 */
function buildEventBody({ event, timestamp, data, sequence = null }) {
  const body = { event, timestamp, apiVersion: WEBHOOK_API_VERSION, data };
  if (sequence !== null && sequence !== undefined) body.sequence = sequence;
  return body;
}

module.exports = { WEBHOOK_API_VERSION, buildEventBody };
