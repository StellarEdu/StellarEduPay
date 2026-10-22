'use strict';

/**
 * Tests for Issue #1782 — the anchor flow fetches stellar.toml from a
 * school-controlled homeDomain. Private, loopback, link-local and in-cluster
 * hosts must be refused before any outbound request is made.
 */

const StellarSdk = require('@stellar/stellar-sdk');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const axios = require('axios').default;
const mockAxiosGet = jest.spyOn(axios, 'get');
const mockAxiosPost = jest.spyOn(axios, 'post');

let mockSchool;

jest.mock('../src/models/schoolModel', () => ({
  findOne: (...a) => mockSchool(...a),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: jest.fn(() => ({ lean: () => Promise.resolve({ studentId: 'STU-1' }) })),
}));

jest.mock('../src/services/transactionPollingService', () => ({
  processTransaction: jest.fn(),
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {},
  networkPassphrase: jest.requireActual('@stellar/stellar-sdk').Networks.TESTNET,
}));

const {
  discoverAnchorEndpoints,
  initiateAnchorDeposit,
  stopAllAnchorPolls,
} = require('../src/services/anchorService');

const BLOCKED_HOMEDOMAINS = [
  '169.254.169.254',                      // cloud metadata service
  '127.0.0.1',                            // loopback
  'localhost:5000',                       // loopback with port
  '10.0.0.5',                             // RFC 1918
  '192.168.1.10',                         // RFC 1918
  'internal-service.svc.cluster.local',   // in-cluster service name
  '[::1]',                                // IPv6 loopback
];

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ANCHOR_PLATFORM_KEYPAIR = StellarSdk.Keypair.random().secret();
});

afterAll(() => {
  delete process.env.ANCHOR_PLATFORM_KEYPAIR;
});

beforeEach(() => {
  jest.clearAllMocks();
  stopAllAnchorPolls();
  mockAxiosGet.mockResolvedValue({ data: '' });
  mockAxiosPost.mockResolvedValue({ data: {} });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #1782 — homeDomain SSRF guard', () => {
  test.each(BLOCKED_HOMEDOMAINS)('discoverAnchorEndpoints refuses %s without making a request', async (host) => {
    await expect(discoverAnchorEndpoints(host)).rejects.toThrow();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  test.each(BLOCKED_HOMEDOMAINS)('initiateAnchorDeposit refuses a school-configured homeDomain %s', async (host) => {
    mockSchool = jest.fn(() => ({
      lean: () => Promise.resolve({
        schoolId: 'SCH-1',
        stellarAddress: StellarSdk.Keypair.random().publicKey(),
        settings: {
          acceptedAnchors: [{ id: 'evil', homeDomain: host, assetCode: 'USDC', enabled: true }],
        },
      }),
    }));

    await expect(
      initiateAnchorDeposit({ schoolId: 'SCH-1', studentId: 'STU-1', anchorId: 'evil' })
    ).rejects.toThrow();
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('a public anchor domain is still resolved to its SEP-10 and SEP-24 endpoints', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: 'WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"\nTRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"',
    });

    const endpoints = await discoverAnchorEndpoints('anchor.example.com');

    expect(endpoints).toEqual({
      sep10Url: 'https://anchor.example.com/auth',
      sep24Url: 'https://anchor.example.com/sep24',
    });
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://anchor.example.com/.well-known/stellar.toml',
      expect.anything()
    );
  });
});
