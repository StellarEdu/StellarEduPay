'use strict';

/**
 * Wallet rotation keeps retired addresses draining (#1799).
 *
 * Verifies:
 *   1. A rotation starts the new address at its current ledger, not from genesis.
 *   2. backfill: true is the only way to replay the new address's history.
 *   3. The old address is retired with its own cursor and a 90-day drain window.
 *   4. Repeated rotations keep every retired address (the old one is not dropped).
 *   5. Only retired addresses still inside their drain window are polled.
 *   6. The poller reads and advances a retired address's own cursor.
 */

const StellarSdk = require('@stellar/stellar-sdk');
const School = require('../src/models/schoolModel');
const { server } = require('../src/config/stellarConfig');
const { extractValidPayment } = require('../src/services/stellarService');
const Payment = require('../src/models/paymentModel');
const {
  WALLET_DRAIN_WINDOW_MS,
  buildWalletRotation,
  drainingWalletEntries,
} = require('../src/services/walletRotationService');
const { pollSchoolWithDrainingAddresses } = require('../src/services/transactionPollingService');

jest.mock('../src/config/stellarConfig', () => ({ server: { transactions: jest.fn() } }));
// paymentLimits pulls in the env config loader, which needs a full environment.
jest.mock('../src/config', () => ({}));
jest.mock('../src/utils/paymentLimits', () => ({ validatePaymentAmount: jest.fn().mockResolvedValue({ valid: true }) }));
jest.mock('../src/services/stellarService', () => ({
  extractValidPayment: jest.fn().mockResolvedValue(null),
  detectMemoCollision: jest.fn(),
  detectCrossSchoolMemoCollision: jest.fn(),
  detectAbnormalPatterns: jest.fn(),
  determineConfirmationState: jest.fn(),
}));

const OLD = StellarSdk.Keypair.random().publicKey();
const NEW = StellarSdk.Keypair.random().publicKey();
const RETIRED = StellarSdk.Keypair.random().publicKey();
const DAY = 24 * 60 * 60 * 1000;

// Fake Horizon builder: records every address/cursor it is asked for and
// returns the page configured for that address.
function fakeHorizon(pages) {
  const calls = [];
  server.transactions.mockImplementation(() => {
    const state = { address: null, cursor: null };
    const builder = {
      forAccount(address) { state.address = address; calls.push(state); return builder; },
      order() { return builder; },
      limit() { return builder; },
      cursor(value) { state.cursor = value; return builder; },
      call: async () => pages[state.address] || { records: [] },
    };
    return builder;
  });
  return calls;
}

describe('Wallet rotation history (#1799)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('buildWalletRotation', () => {
    it('starts the new address at its current ledger instead of replaying history', async () => {
      fakeHorizon({ [NEW]: { records: [{ paging_token: 'tok-latest' }] } });
      const school = { stellarAddress: OLD, syncCursor: 'tok-old' };
      const now = new Date('2026-10-01T00:00:00Z');

      const rotation = await buildWalletRotation(school, NEW, { now });

      expect(rotation.syncCursor).toBe('tok-latest');
      expect(rotation.walletActiveFrom).toEqual(now);
    });

    it('leaves the cursor null only when backfill is requested', async () => {
      const calls = fakeHorizon({});
      const rotation = await buildWalletRotation({ stellarAddress: OLD }, NEW, { backfill: true });

      expect(rotation.syncCursor).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('retires the old address with its own cursor and a 90-day drain window', async () => {
      fakeHorizon({ [NEW]: { records: [] } });
      const now = new Date('2026-10-01T00:00:00Z');
      const school = { stellarAddress: OLD, syncCursor: 'tok-old-cursor', walletActiveFrom: new Date('2026-01-01T00:00:00Z') };

      const { retired } = await buildWalletRotation(school, NEW, { now });

      expect(retired).toEqual({
        address: OLD,
        activeFrom: new Date('2026-01-01T00:00:00Z'),
        activeUntil: now,
        drainUntil: new Date(now.getTime() + WALLET_DRAIN_WINDOW_MS),
        cursor: 'tok-old-cursor',
      });
      expect(WALLET_DRAIN_WINDOW_MS).toBe(90 * DAY);
    });

    it('rejects when Horizon cannot report the new address position', async () => {
      server.transactions.mockImplementation(() => {
        const builder = { forAccount: () => builder, order: () => builder, limit: () => builder, call: async () => { throw new Error('horizon down'); } };
        return builder;
      });

      await expect(buildWalletRotation({ stellarAddress: OLD }, NEW)).rejects.toThrow('horizon down');
    });
  });

  describe('drainingWalletEntries', () => {
    it('returns only retired addresses whose drain window has not passed', () => {
      const now = new Date('2026-10-01T00:00:00Z');
      const school = {
        walletHistory: [
          { address: OLD, cursor: 'c-old', drainUntil: new Date(now.getTime() - DAY) },
          { address: RETIRED, cursor: 'c-r', drainUntil: new Date(now.getTime() + DAY) },
        ],
      };

      expect(drainingWalletEntries(school, now)).toEqual([{ address: RETIRED, cursor: 'c-r' }]);
    });
  });

  describe('School.walletHistory schema', () => {
    it('keeps the first retired address after a second rotation', () => {
      const doc = new School({ schoolId: 'SCH-WH-1', name: 'WH', slug: 'wh-1', stellarAddress: NEW });
      const now = new Date();
      doc.walletHistory.push({ address: OLD, activeUntil: now, drainUntil: now, cursor: 'a' });
      doc.walletHistory.push({ address: NEW, activeUntil: now, drainUntil: now, cursor: 'b' });

      expect(doc.walletHistory.map(e => e.address)).toEqual([OLD, NEW]);
      expect(doc.validateSync()).toBeUndefined();
    });

    it('rejects a retired entry with an invalid Stellar address', () => {
      const doc = new School({ schoolId: 'SCH-WH-2', name: 'WH', slug: 'wh-2', stellarAddress: NEW });
      doc.walletHistory.push({ address: 'not-a-key', activeUntil: new Date(), drainUntil: new Date() });

      expect(doc.validateSync().errors['walletHistory.0.address']).toBeDefined();
    });
  });

  describe('polling a draining address', () => {
    it('polls the retired address with its own cursor and advances that cursor', async () => {
      const calls = fakeHorizon({
        [NEW]: { records: [] },
        [RETIRED]: { records: [{ hash: 'tx-retired-1', paging_token: 'cur-r-2' }] },
      });
      const updateOne = jest.spyOn(School, 'updateOne').mockResolvedValue({});
      jest.spyOn(Payment, 'findOne').mockResolvedValue(null);

      const school = {
        schoolId: 'SCH-WH-POLL',
        stellarAddress: NEW,
        syncCursor: null,
        walletHistory: [
          { address: RETIRED, cursor: 'cur-r-1', drainUntil: new Date(Date.now() + DAY) },
          { address: OLD, cursor: 'cur-o', drainUntil: new Date(Date.now() - DAY) },
        ],
      };

      await pollSchoolWithDrainingAddresses(school, null);

      const addresses = calls.map(c => c.address);
      expect(addresses).toContain(NEW);
      expect(addresses).toContain(RETIRED);
      expect(addresses).not.toContain(OLD);

      const retiredCall = calls.find(c => c.address === RETIRED);
      expect(retiredCall.cursor).toBe('cur-r-1');

      expect(extractValidPayment).toHaveBeenCalledWith(expect.objectContaining({ hash: 'tx-retired-1' }), RETIRED);
      expect(updateOne).toHaveBeenCalledWith(
        { schoolId: 'SCH-WH-POLL', 'walletHistory.address': RETIRED },
        { $set: { 'walletHistory.$.cursor': 'cur-r-2' } },
      );
    });
  });
});
