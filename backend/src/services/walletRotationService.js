'use strict';

/**
 * Wallet rotation bookkeeping (#1799).
 *
 * When a school changes its payment address, the old address is retired into
 * `walletHistory` and keeps being polled until its `drainUntil` passes, so
 * payments that were already in flight, or that a parent sent from an old
 * reminder, are still credited.
 */

const WALLET_DRAIN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Paging token of the newest transaction on `address`, or null if the account
 * has no history. Starting the new address's cursor here means the poller only
 * sees payments made after the rotation, instead of replaying an existing
 * account's history.
 */
async function latestPagingToken(address) {
  // Required lazily: loading stellarConfig pulls in the env config loader, and
  // controllers that only need the pure helpers should not pay for it.
  const { server } = require('../config/stellarConfig');
  const page = await server
    .transactions()
    .forAccount(address)
    .order('desc')
    .limit(1)
    .call();
  return (page && page.records && page.records[0] && page.records[0].paging_token) || null;
}

/**
 * Compute what a rotation to `newAddress` must write.
 *
 * Throws if Horizon cannot report the new address's current position: starting
 * from null would replay the whole history of a reused account, so the caller
 * must refuse the rotation rather than guess.
 *
 * @param {object} school  Current school document (or lean copy).
 * @param {string} newAddress
 * @param {{ backfill?: boolean, now?: Date }} [opts]
 *   backfill: true deliberately replays the new address's history.
 * @returns {Promise<{ retired: object, syncCursor: string|null, walletActiveFrom: Date }>}
 */
async function buildWalletRotation(school, newAddress, { backfill = false, now = new Date() } = {}) {
  const syncCursor = backfill ? null : await latestPagingToken(newAddress);

  return {
    retired: {
      address: school.stellarAddress,
      activeFrom: school.walletActiveFrom || school.createdAt || null,
      activeUntil: now,
      drainUntil: new Date(now.getTime() + WALLET_DRAIN_WINDOW_MS),
      // The old address's own cursor, so draining resumes exactly where
      // the poller stopped and nothing is skipped or re-read.
      cursor: school.syncCursor || null,
    },
    syncCursor,
    walletActiveFrom: now,
  };
}

/**
 * Retired addresses that are still inside their drain window.
 * @param {object} school
 * @param {Date} [now]
 * @returns {Array<{address: string, cursor: string|null}>}
 */
function drainingWalletEntries(school, now = new Date()) {
  return (school.walletHistory || [])
    .filter(entry => entry.address && entry.drainUntil && new Date(entry.drainUntil) > now)
    .map(entry => ({ address: entry.address, cursor: entry.cursor || null }));
}

module.exports = {
  WALLET_DRAIN_WINDOW_MS,
  buildWalletRotation,
  drainingWalletEntries,
  latestPagingToken,
};
