'use strict';

/**
 * Tests for Issue #1779 — SEP-10 client must refuse to sign challenges it
 * cannot validate (sequence ≠ 0, payment operations, wrong source / server
 * signature, expired time bounds, foreign network passphrase).
 *
 * Uses the real @stellar/stellar-sdk to build challenge transactions so the
 * validation is exercised against genuine XDR, not hand-written fixtures.
 */

const StellarSdk = jest.requireActual('@stellar/stellar-sdk');

const OUR_PASSPHRASE = StellarSdk.Networks.TESTNET;
const FOREIGN_PASSPHRASE = StellarSdk.Networks.PUBLIC;
const HOME_DOMAIN = 'anchor.example.com';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// The real axios is spied on (not replaced) so the SDK's HTTP client still loads.
const axios = require('axios').default;
const mockAxiosGet = jest.spyOn(axios, 'get');
const mockAxiosPost = jest.spyOn(axios, 'post');

jest.mock('../src/models/schoolModel', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: jest.fn(),
}));

jest.mock('../src/services/transactionPollingService', () => ({
  processTransaction: jest.fn(),
}));

jest.mock('../src/config/stellarConfig', () => {
  const S = jest.requireActual('@stellar/stellar-sdk');
  return {
    server: {},
    networkPassphrase: S.Networks.TESTNET,
  };
});

const { sep10Authenticate } = require('../src/services/anchorService');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const platformKp = StellarSdk.Keypair.random();
const serverKp = StellarSdk.Keypair.random();   // the anchor's SIGNING_KEY
const attackerKp = StellarSdk.Keypair.random(); // not the anchor's key
const clientKp = StellarSdk.Keypair.random();   // the account being authenticated

const SEP10_URL = 'https://anchor.example.com/auth';

/**
 * Build a challenge-shaped transaction with the given properties. The builder
 * increments the source sequence, so we start one below the target sequence.
 */
function buildChallenge({
  signer = serverKp,
  sequence = '0',
  passphrase = OUR_PASSPHRASE,
  operations,
  timebounds = { minTime: 0, maxTime: 0 },
} = {}) {
  const source = new StellarSdk.Account(
    signer.publicKey(),
    String(BigInt(sequence) - 1n)
  );

  const builder = new StellarSdk.TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: passphrase,
    timebounds,
  });

  const ops = operations || [
    StellarSdk.Operation.manageData({
      name: `${HOME_DOMAIN} auth`,
      value: Buffer.from('nonce-value-1234567890123456789012').toString('base64'),
      source: clientKp.publicKey(),
    }),
  ];
  ops.forEach(op => builder.addOperation(op));

  const tx = builder.build();
  tx.sign(signer);
  return tx.toXDR();
}

function freshTimebounds() {
  const now = Math.floor(Date.now() / 1000);
  return { minTime: now - 10, maxTime: now + 300 };
}

function serveChallenge(transaction, networkPassphrase = OUR_PASSPHRASE) {
  mockAxiosGet.mockResolvedValueOnce({
    data: { transaction, network_passphrase: networkPassphrase },
  });
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
  mockAxiosPost.mockResolvedValue({ data: { token: 'jwt-token' } });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #1779 — SEP-10 challenge validation before signing', () => {
  test('signs and returns a JWT for a well-formed challenge', async () => {
    serveChallenge(buildChallenge({ timebounds: freshTimebounds() }));

    const jwt = await sep10Authenticate(SEP10_URL, clientKp.publicKey());

    expect(jwt).toBe('jwt-token');
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  test('refuses a challenge whose sequence number is not 0', async () => {
    serveChallenge(buildChallenge({ sequence: '42', timebounds: freshTimebounds() }));

    await expect(sep10Authenticate(SEP10_URL, clientKp.publicKey())).rejects.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('refuses a challenge that contains a payment operation', async () => {
    const paymentOp = StellarSdk.Operation.payment({
      destination: attackerKp.publicKey(),
      asset: StellarSdk.Asset.native(),
      amount: '1000',
      source: clientKp.publicKey(),
    });
    serveChallenge(buildChallenge({
      operations: [paymentOp],
      timebounds: freshTimebounds(),
    }));

    await expect(sep10Authenticate(SEP10_URL, clientKp.publicKey())).rejects.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('refuses a challenge whose server signature is not the anchor signing key', async () => {
    serveChallenge(buildChallenge({
      signer: attackerKp,
      timebounds: freshTimebounds(),
    }));

    await expect(sep10Authenticate(SEP10_URL, clientKp.publicKey())).rejects.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('refuses a challenge with expired time bounds', async () => {
    const now = Math.floor(Date.now() / 1000);
    serveChallenge(buildChallenge({
      timebounds: { minTime: now - 7200, maxTime: now - 3600 },
    }));

    await expect(sep10Authenticate(SEP10_URL, clientKp.publicKey())).rejects.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('refuses a challenge whose network passphrase differs from ours', async () => {
    // The anchor claims a different network in its response and the challenge
    // was built for that network. Our deployment is on testnet.
    serveChallenge(
      buildChallenge({ passphrase: FOREIGN_PASSPHRASE, timebounds: freshTimebounds() }),
      FOREIGN_PASSPHRASE
    );

    await expect(sep10Authenticate(SEP10_URL, clientKp.publicKey())).rejects.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('never signs with the platform key when the response passphrase is spoofed', async () => {
    // Challenge is valid for testnet, but the anchor's response advertises mainnet.
    serveChallenge(
      buildChallenge({ timebounds: freshTimebounds() }),
      FOREIGN_PASSPHRASE
    );

    await expect(sep10Authenticate(SEP10_URL, clientKp.publicKey())).rejects.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});
