'use strict';

/**
 * True when a transaction predates the school's ingest start point (#1818).
 * The poller still advances its cursor past such transactions, so they are
 * read once and never re-processed.
 */
function isBeforeIngestStart(tx, school) {
  if (!school || !school.ingestStartsAt || !tx || !tx.created_at) return false;
  const txTime = new Date(tx.created_at).getTime();
  const startTime = new Date(school.ingestStartsAt).getTime();
  if (Number.isNaN(txTime) || Number.isNaN(startTime)) return false;
  return txTime < startTime;
}

module.exports = { isBeforeIngestStart };
