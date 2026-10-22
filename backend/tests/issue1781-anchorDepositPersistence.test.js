'use strict';

/**
 * Tests for Issue #1781 — SEP-24 deposit tracking must survive restarts, be
 * recorded in the database, and re-authenticate when the anchor JWT expires
 * instead of silently dropping the deposit.
 */

const StellarSdk = require('@stellar/stellar-sdk');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const axios = require('axios').default;
const mockAxiosGet = jest.spyOn(axios, 'get');
const mockAxiosPost = jest.spyOn(axios, 'post');

const HOME_DOMAIN = 'anchor.example.com';
const SEP10_URL = `https://${HOME_DOMAIN}/auth`;
const SEP24_URL = `https://${HOME_DOMAIN}/sep24`;
const SCHOOL_WALLET = StellarSdk.Keypair.random().publicKey();

let mockSchool;
const mockProcessTransaction = jest.fn().mockResolvedValue({ processed: true });

// Persistence model for anchor deposits (issue #1781 proposed collection).
const mockAnchorDepositCreate = jest.fn().mockResolvedValue({});
const mockAnchorDepositUpdateOne = jest.fn().mockResolvedValue({});
const mockAnchorDepositFind = jest.fn();

jest.mock('../src/models/anchorDepositModel', () => ({
  create: (...a) => mockAnchorDepositCreate(...a),
  updateOne: (...a) => mockAnchorDepositUpdateOne(...a),
  find: (...a) => mockAnchorDepositFind(...a),
}), { virtual: true });

jest.mock('../src/models/schoolModel', () => ({
  findOne: (...a) => mockSchool(...a),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: jest.fn(() => ({ lean: () => Promise.resolve({ studentId: 'STU-1' }) })),
}));

jest.mock('../src/services/transactionPollingService', () => ({
  processTransaction: (...a) => mockProcessTransaction(...a),
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({
      transaction: () => ({ call: async () => ({ hash: 'horizon-hash' }) }),
    }),
  },
  networkPassphrase: jest.requireActual('@stellar/stellar-sdk').Networks.TESTNET,
}));

const anchorService = require('../src/services/anchorService');
const { initiateAnchorDeposit, stopAllAnchorPolls } = anchorService;

// ── Helpers ───────────────────────────────────────────────────────────────────

const platformKp = StellarSdk.Keypair.random();
const serverKp = StellarSdk.Keypair.random();

function buildChallenge(clientAccount) {
  const now = Math.floor(Date.now() / 1000);
  const source = new StellarSdk.Account(serverKp.publicKey(), '-1');
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
    timebounds: { minTime: now - 10, maxTime: now + 300 },
  })
    .addOperation(StellarSdk.Operation.manageData({
      name: `${HOME_DOMAIN} auth`,
      value: Buffer.from('nonce-value-1234567890123456789012').toString('base64'),
      source: clientAccount,
    }))
    .build();
  tx.sign(serverKp);
  return tx.toXDR();
}

const TOML = `WEB_AUTH_ENDPOINT = "${SEP10_URL}"\nTRANSFER_SERVER_SEP0024 = "${SEP24_URL}"`;

/**
 * Anchor double: each SEP-10 login issues a new JWT. The status endpoint only
 * accepts the most recent JWT and reports the deposit as completed on it.
 */
function serveAnchor({ statusWhenAuthed = 'completed' } = {}) {
  let tokenCount = 0;
  let currentJwt = null;

  mockAxiosGet.mockImplementation(async (url, opts = {}) => {
    if (url.endsWith('/.well-known/stellar.toml')) return { data: TOML };
    if (url.startsWith(SEP10_URL)) {
      const account = new URL(url).searchParams.get('account');
      return { data: { transaction: buildChallenge(account), network_passphrase: StellarSdk.Networks.TESTNET } };
    }
    if (url.startsWith(`${SEP24_URL}/transaction?`)) {
      const auth = opts.headers?.Authorization;
      if (auth !== `Bearer ${currentJwt}`) {
        const err = new Error('Request failed with status code 401');
        err.response = { status: 401 };
        throw err;
      }
      return {
        data: {
          transaction: {
            status: statusWhenAuthed,
            stellar_transaction_id: 'stellar-hash-1',
          },
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  mockAxiosPost.mockImplementation(async (url) => {
    if (url === SEP10_URL) {
      tokenCount += 1;
      currentJwt = `jwt-${tokenCount}`;
      return { data: { token: currentJwt } };
    }
    if (url.startsWith(`${SEP24_URL}/transactions/deposit/interactive`)) {
      return { data: { url: `https://${HOME_DOMAIN}/interactive/abc`, id: 'anchor-tx-1' } };
    }
    throw new Error(`unexpected POST ${url}`);
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ANCHOR_PLATFORM_KEYPAIR = platformKp.secret();
  process.env.ANCHOR_POLL_INTERVAL_MS = '1000';
});

afterAll(() => {
  delete process.env.ANCHOR_PLATFORM_KEYPAIR;
  delete process.env.ANCHOR_POLL_INTERVAL_MS;
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  stopAllAnchorPolls();
  mockSchool = jest.fn(() => ({
    lean: () => Promise.resolve({
      schoolId: 'SCH-1',
      stellarAddress: SCHOOL_WALLET,
      settings: {
        acceptedAnchors: [{ id: 'anchor-1', homeDomain: HOME_DOMAIN, assetCode: 'USDC', enabled: true }],
      },
    }),
  }));
  serveAnchor();
});

afterEach(() => {
  stopAllAnchorPolls();
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #1781 — SEP-24 deposit persistence and polling recovery', () => {
  test('records the deposit in the database when it is initiated', async () => {
    await initiateAnchorDeposit({ schoolId: 'SCH-1', studentId: 'STU-1', anchorId: 'anchor-1' });

    expect(mockAnchorDepositCreate).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: 'SCH-1',
      studentId: 'STU-1',
      anchorId: 'anchor-1',
      anchorTxId: 'anchor-tx-1',
      status: 'pending',
    }));
  });

  test('re-authenticates with SEP-10 when the anchor JWT expires mid-poll and still processes the deposit', async () => {
    await initiateAnchorDeposit({ schoolId: 'SCH-1', studentId: 'STU-1', anchorId: 'anchor-1' });

    // First poll runs with the original JWT, which the anchor now rejects with 401.
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    const sep10Logins = mockAxiosPost.mock.calls.filter(([url]) => url === SEP10_URL);
    expect(sep10Logins.length).toBeGreaterThanOrEqual(2);
    expect(mockProcessTransaction).toHaveBeenCalledTimes(1);
  });

  test('resumes tracking pending deposits after a restart, using the database record', async () => {
    mockAnchorDepositFind.mockReturnValue({
      lean: () => Promise.resolve([{
        anchorId: 'anchor-1',
        anchorTxId: 'anchor-tx-1',
        schoolId: 'SCH-1',
        studentId: 'STU-1',
        status: 'pending',
      }]),
    });

    // Simulates process start-up after a deploy: no in-memory polls exist.
    expect(anchorService._activePolls.size).toBe(0);
    await anchorService.resumePendingAnchorDeposits();

    expect(mockAnchorDepositFind).toHaveBeenCalledWith(expect.objectContaining({
      status: expect.anything(),
    }));
    expect(anchorService._activePolls.has('anchor-tx-1')).toBe(true);
  });

  test('does not keep the anchor JWT on the in-memory poll record', async () => {
    await initiateAnchorDeposit({ schoolId: 'SCH-1', studentId: 'STU-1', anchorId: 'anchor-1' });

    const entry = anchorService._activePolls.get('anchor-tx-1');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toMatch(/jwt-\d/);
  });
});
