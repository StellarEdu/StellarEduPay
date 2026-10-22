'use strict';

/**
 * Tests for Issue #1780 — SEP-24 deposit must request funds for the account
 * that SEP-10 authenticated, and the returned interactive URL must stay on the
 * anchor's domain before it is handed to the browser.
 */

const StellarSdk = require('@stellar/stellar-sdk');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const axios = require('axios').default;
const mockAxiosGet = jest.spyOn(axios, 'get');
const mockAxiosPost = jest.spyOn(axios, 'post');

const SCHOOL_WALLET = StellarSdk.Keypair.random().publicKey();
const HOME_DOMAIN = 'anchor.example.com';
const SEP10_URL = `https://${HOME_DOMAIN}/auth`;
const SEP24_URL = `https://${HOME_DOMAIN}/sep24`;

let mockSchool;

jest.mock('../src/models/schoolModel', () => ({
  findOne: (...a) => mockSchool(...a),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: jest.fn(() => ({
    lean: () => Promise.resolve({ studentId: 'STU-1' }),
  })),
}));

jest.mock('../src/services/transactionPollingService', () => ({
  processTransaction: jest.fn(),
}));

jest.mock('../src/config/stellarConfig', () => {
  const S = jest.requireActual('@stellar/stellar-sdk');
  return { server: {}, networkPassphrase: S.Networks.TESTNET };
});

const { initiateAnchorDeposit, stopAllAnchorPolls } = require('../src/services/anchorService');

// ── Helpers ───────────────────────────────────────────────────────────────────

const platformKp = StellarSdk.Keypair.random();
const serverKp = StellarSdk.Keypair.random();

/** Valid SEP-10 challenge for `clientAccount`, signed by the anchor. */
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

const TOML = [
  `WEB_AUTH_ENDPOINT = "${SEP10_URL}"`,
  `TRANSFER_SERVER_SEP0024 = "${SEP24_URL}"`,
].join('\n');

/**
 * Route axios calls: stellar.toml, the SEP-10 challenge, the SEP-10 token,
 * and the SEP-24 deposit. `interactiveUrl` lets a test choose what the anchor returns.
 */
function serveAnchor({ interactiveUrl = `https://${HOME_DOMAIN}/interactive/abc` } = {}) {
  mockAxiosGet.mockImplementation(async (url) => {
    if (url.endsWith('/.well-known/stellar.toml')) return { data: TOML };
    if (url.startsWith(SEP10_URL)) {
      const account = new URL(url).searchParams.get('account');
      return { data: { transaction: buildChallenge(account), network_passphrase: StellarSdk.Networks.TESTNET } };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  mockAxiosPost.mockImplementation(async (url) => {
    if (url === SEP10_URL) return { data: { token: 'jwt-token' } };
    if (url.startsWith(`${SEP24_URL}/transactions/deposit/interactive`)) {
      return { data: { url: interactiveUrl, id: 'anchor-tx-1' } };
    }
    throw new Error(`unexpected POST ${url}`);
  });
}

function depositBody() {
  const call = mockAxiosPost.mock.calls.find(([url]) => url.includes('/transactions/deposit/interactive'));
  return new URLSearchParams(call[1]);
}

function sep10ChallengeAccount() {
  const call = mockAxiosGet.mock.calls.find(([url]) => url.startsWith(SEP10_URL));
  return new URL(call[0]).searchParams.get('account');
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ANCHOR_PLATFORM_KEYPAIR = platformKp.secret();
});

afterAll(() => {
  delete process.env.ANCHOR_PLATFORM_KEYPAIR;
});

beforeEach(() => {
  jest.clearAllMocks();
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #1780 — SEP-24 deposit account matches the SEP-10 authenticated account', () => {
  test('deposit "account" is the same account SEP-10 authenticated', async () => {
    await initiateAnchorDeposit({ schoolId: 'SCH-1', studentId: 'STU-1', anchorId: 'anchor-1' });

    const authenticated = sep10ChallengeAccount();
    expect(depositBody().get('account')).toBe(authenticated);
  });

  test('refuses an interactive URL that is not on the anchor\'s home domain', async () => {
    serveAnchor({ interactiveUrl: 'https://evil.example.net/phish' });

    await expect(
      initiateAnchorDeposit({ schoolId: 'SCH-1', studentId: 'STU-1', anchorId: 'anchor-1' })
    ).rejects.toThrow();
  });
});
