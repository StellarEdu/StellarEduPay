'use strict';

/**
 * Tests for Issue #1571 — SEP-24 Anchor Service
 * (anchorService: discoverAnchorEndpoints, resolveAnchorConfig,
 *  listAnchorsForSchool, initiateAnchorDeposit, fetchAnchorTxStatus,
 *  stopAllAnchorPolls, background polling lifecycle).
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockSchoolFindOne;
let mockStudentFindOne;
let mockProcessTransaction;

// Axios mock functions — reassigned per test via mockImplementation / mockResolvedValue.
// { virtual: true } because axios is a declared dep but may not be installed at test time.
const mockAxiosGet  = jest.fn();
const mockAxiosPost = jest.fn();

jest.mock('axios', () => ({
  default: {
    get:  (...a) => mockAxiosGet(...a),
    post: (...a) => mockAxiosPost(...a),
  },
}), { virtual: true });

jest.mock('../src/models/schoolModel', () => ({
  findOne:   (...a) => mockSchoolFindOne(...a),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: (...a) => mockStudentFindOne(...a),
}));

jest.mock('../src/services/transactionPollingService', () => ({
  processTransaction: (...a) => mockProcessTransaction(...a),
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {
    transactions: jest.fn().mockReturnValue({
      transaction: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ hash: 'horizon-tx-hash' }),
    }),
  },
}));

// { virtual: true } because @stellar/stellar-sdk may not be installed at test time.
jest.mock('@stellar/stellar-sdk', () => {
  const mockPublicKey = 'GPLATFORM000000000000000000000000000000000000000000000001';
  return {
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({ publicKey: () => mockPublicKey }),
    },
    Transaction: jest.fn().mockImplementation(() => ({
      sign:       jest.fn(),
      toEnvelope: () => ({ toXDR: () => 'signed-tx-base64' }),
    })),
  };
}, { virtual: true });

jest.mock('../src/utils/logger', () => ({
  child: () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SCHOOL_ID       = 'SCH-001';
const STUDENT_ID      = 'STU-001';
const ANCHOR_ID       = 'anchor-test';
const HOME_DOMAIN     = 'anchor.example.com';
const ANCHOR_TX_ID    = 'anc-tx-id-001';
const INTERACTIVE_URL = 'https://anchor.example.com/interactive?token=xyz';

const TOML_CONTENT = `
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"
`;

function makeSchool(anchorOverrides = {}) {
  return {
    schoolId:       SCHOOL_ID,
    stellarAddress: 'GSCHOOL000000000000000000000000000000000000000000000000001',
    isActive:       true,
    settings: {
      acceptedAnchors: [
        {
          id:          ANCHOR_ID,
          homeDomain:  HOME_DOMAIN,
          assetCode:   'USDC',
          assetIssuer: 'GUSDC00000000000000000000000000000000000000000000000000001',
          enabled:     true,
          label:       'Test Anchor',
          ...anchorOverrides,
        },
      ],
    },
  };
}

function makeStudent() {
  return { schoolId: SCHOOL_ID, studentId: STUDENT_ID, deletedAt: null };
}

// Save / restore ANCHOR_PLATFORM_KEYPAIR env var across tests.
const ORIG_KEYPAIR = process.env.ANCHOR_PLATFORM_KEYPAIR;
beforeEach(() => {
  process.env.ANCHOR_PLATFORM_KEYPAIR = 'SECRET_KEYPAIR_FOR_TEST';
  mockAxiosGet.mockReset();
  mockAxiosPost.mockReset();
  mockProcessTransaction = jest.fn().mockResolvedValue({ processed: true });
});
afterAll(() => {
  if (ORIG_KEYPAIR !== undefined) process.env.ANCHOR_PLATFORM_KEYPAIR = ORIG_KEYPAIR;
  else delete process.env.ANCHOR_PLATFORM_KEYPAIR;
});

// Import after all mocks are in place.
const {
  discoverAnchorEndpoints,
  resolveAnchorConfig,
  listAnchorsForSchool,
  fetchAnchorTxStatus,
  initiateAnchorDeposit,
  stopAllAnchorPolls,
  sep10Authenticate,
  _activePolls,
} = require('../src/services/anchorService');

// ─────────────────────────────────────────────────────────────────────────────
// discoverAnchorEndpoints
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverAnchorEndpoints', () => {
  test('parses SEP-10 and SEP-24 URLs from stellar.toml', async () => {
    mockAxiosGet.mockResolvedValue({ data: TOML_CONTENT });

    const { sep10Url, sep24Url } = await discoverAnchorEndpoints(HOME_DOMAIN);
    expect(sep10Url).toBe('https://anchor.example.com/auth');
    expect(sep24Url).toBe('https://anchor.example.com/sep24');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      `https://${HOME_DOMAIN}/.well-known/stellar.toml`,
      expect.any(Object)
    );
  });

  test('throws when WEB_AUTH_ENDPOINT is missing from toml', async () => {
    mockAxiosGet.mockResolvedValue({
      data: `TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"`,
    });
    await expect(discoverAnchorEndpoints(HOME_DOMAIN)).rejects.toThrow('WEB_AUTH_ENDPOINT');
  });

  test('throws when TRANSFER_SERVER_SEP0024 is missing from toml', async () => {
    mockAxiosGet.mockResolvedValue({
      data: `WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"`,
    });
    await expect(discoverAnchorEndpoints(HOME_DOMAIN)).rejects.toThrow('TRANSFER_SERVER_SEP0024');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAnchorConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAnchorConfig', () => {
  test('returns anchor config when it is configured and enabled', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });

    const anchor = await resolveAnchorConfig(SCHOOL_ID, ANCHOR_ID);
    expect(anchor.id).toBe(ANCHOR_ID);
    expect(anchor.assetCode).toBe('USDC');
  });

  test('throws NOT_FOUND when school does not exist', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(resolveAnchorConfig(SCHOOL_ID, ANCHOR_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('throws ANCHOR_NOT_CONFIGURED when anchor id is not in school settings', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    await expect(resolveAnchorConfig(SCHOOL_ID, 'unknown-anchor'))
      .rejects.toMatchObject({ code: 'ANCHOR_NOT_CONFIGURED' });
  });

  test('treats anchors with enabled=false as not configured', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(makeSchool({ enabled: false })),
    });
    await expect(resolveAnchorConfig(SCHOOL_ID, ANCHOR_ID))
      .rejects.toMatchObject({ code: 'ANCHOR_NOT_CONFIGURED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listAnchorsForSchool
// ─────────────────────────────────────────────────────────────────────────────

describe('listAnchorsForSchool', () => {
  test('returns enabled school anchors', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    const anchors = await listAnchorsForSchool(SCHOOL_ID);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toBe(ANCHOR_ID);
  });

  test('excludes disabled anchors', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(makeSchool({ enabled: false })),
    });
    const anchors = await listAnchorsForSchool(SCHOOL_ID);
    expect(anchors).toHaveLength(0);
  });

  test('throws NOT_FOUND when school is missing', async () => {
    mockSchoolFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(listAnchorsForSchool(SCHOOL_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sep10Authenticate
// ─────────────────────────────────────────────────────────────────────────────

describe('sep10Authenticate', () => {
  const SEP10_URL = 'https://anchor.example.com/auth';
  const ACCOUNT   = 'GPLATFORM000000000000000000000000000000000000000000000001';
  const CHALLENGE = 'AAAAAQAAAAAB...challenge-xdr';
  const NET_PASS  = 'Test SDF Network ; September 2015';
  const TOKEN     = 'jwt.anchor.token.here';

  test('exchanges challenge for JWT token', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { transaction: CHALLENGE, network_passphrase: NET_PASS },
    });
    mockAxiosPost.mockResolvedValue({ data: { token: TOKEN } });

    const jwt = await sep10Authenticate(SEP10_URL, ACCOUNT);

    expect(jwt).toBe(TOKEN);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      `${SEP10_URL}?account=${encodeURIComponent(ACCOUNT)}`,
      expect.any(Object)
    );
    expect(mockAxiosPost).toHaveBeenCalledWith(
      SEP10_URL,
      { transaction: 'signed-tx-base64' },
      expect.any(Object)
    );
  });

  test('throws when ANCHOR_PLATFORM_KEYPAIR is not set', async () => {
    delete process.env.ANCHOR_PLATFORM_KEYPAIR;
    mockAxiosGet.mockResolvedValue({
      data: { transaction: CHALLENGE, network_passphrase: NET_PASS },
    });
    await expect(sep10Authenticate(SEP10_URL, ACCOUNT)).rejects.toThrow('ANCHOR_PLATFORM_KEYPAIR');
  });

  test('throws when anchor does not return a token', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { transaction: CHALLENGE, network_passphrase: NET_PASS },
    });
    mockAxiosPost.mockResolvedValue({ data: {} }); // no token field
    await expect(sep10Authenticate(SEP10_URL, ACCOUNT)).rejects.toThrow(/token/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchAnchorTxStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchAnchorTxStatus', () => {
  const SEP24_URL = 'https://anchor.example.com/sep24';
  const JWT       = 'test-jwt-token';

  test('returns the transaction object from the anchor', async () => {
    const anchorTx = { id: ANCHOR_TX_ID, status: 'pending_user_transfer' };
    mockAxiosGet.mockResolvedValue({ data: { transaction: anchorTx } });

    const result = await fetchAnchorTxStatus(SEP24_URL, ANCHOR_TX_ID, JWT);
    expect(result.status).toBe('pending_user_transfer');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      `${SEP24_URL}/transaction?id=${encodeURIComponent(ANCHOR_TX_ID)}`,
      expect.objectContaining({ headers: { Authorization: `Bearer ${JWT}` } })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// initiateAnchorDeposit
// ─────────────────────────────────────────────────────────────────────────────

describe('initiateAnchorDeposit', () => {
  function setupHappyPath() {
    mockSchoolFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(makeSchool()),
    });
    mockStudentFindOne = jest.fn().mockReturnValue({
      lean: () => Promise.resolve(makeStudent()),
    });
    // Call order: toml fetch → sep10 challenge → sep10 jwt → sep24 deposit
    mockAxiosGet
      .mockResolvedValueOnce({ data: TOML_CONTENT })
      .mockResolvedValueOnce({
        data: { transaction: 'CHALLENGE_XDR', network_passphrase: 'Test SDF Network' },
      });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { token: 'sep10-jwt' } })
      .mockResolvedValueOnce({ data: { url: INTERACTIVE_URL, id: ANCHOR_TX_ID } });
  }

  afterEach(() => {
    stopAllAnchorPolls();
    _activePolls.clear();
  });

  test('returns interactiveUrl, anchorTxId, and sep24Url on success', async () => {
    setupHappyPath();
    const result = await initiateAnchorDeposit({
      schoolId:  SCHOOL_ID,
      studentId: STUDENT_ID,
      anchorId:  ANCHOR_ID,
    });
    expect(result.interactiveUrl).toBe(INTERACTIVE_URL);
    expect(result.anchorTxId).toBe(ANCHOR_TX_ID);
    expect(result.sep24Url).toBe('https://anchor.example.com/sep24');
  });

  test('starts background polling after successful initiation', async () => {
    setupHappyPath();
    await initiateAnchorDeposit({
      schoolId:  SCHOOL_ID,
      studentId: STUDENT_ID,
      anchorId:  ANCHOR_ID,
    });
    expect(_activePolls.has(ANCHOR_TX_ID)).toBe(true);
  });

  test('throws VALIDATION_ERROR when required params are missing', async () => {
    await expect(
      initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('throws NOT_FOUND when student does not exist', async () => {
    mockSchoolFindOne  = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    mockStudentFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(
      initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, anchorId: ANCHOR_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('throws when ANCHOR_PLATFORM_KEYPAIR is not configured', async () => {
    delete process.env.ANCHOR_PLATFORM_KEYPAIR;
    mockSchoolFindOne  = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    mockStudentFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeStudent()) });
    mockAxiosGet.mockResolvedValueOnce({ data: TOML_CONTENT });
    await expect(
      initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, anchorId: ANCHOR_ID })
    ).rejects.toThrow('ANCHOR_PLATFORM_KEYPAIR');
  });

  test('throws when SEP-24 response is missing url or id', async () => {
    mockSchoolFindOne  = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    mockStudentFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeStudent()) });
    mockAxiosGet
      .mockResolvedValueOnce({ data: TOML_CONTENT })
      .mockResolvedValueOnce({ data: { transaction: 'CHALLENGE', network_passphrase: 'Net' } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { token: 'jwt' } })
      .mockResolvedValueOnce({ data: {} }); // missing url and id
    await expect(
      initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, anchorId: ANCHOR_ID })
    ).rejects.toThrow(/interactive URL or transaction ID/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stopAllAnchorPolls
// ─────────────────────────────────────────────────────────────────────────────

describe('stopAllAnchorPolls', () => {
  test('clears all active polling entries', () => {
    const timer = setTimeout(() => {}, 100_000);
    _activePolls.set('tx-manual-1', { timer, schoolId: SCHOOL_ID, studentId: STUDENT_ID });

    stopAllAnchorPolls();

    expect(_activePolls.size).toBe(0);
  });

  test('is safe to call when no polls are active', () => {
    _activePolls.clear();
    expect(() => stopAllAnchorPolls()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Background polling — completed status triggers processTransaction
// ─────────────────────────────────────────────────────────────────────────────

describe('anchor background polling', () => {
  jest.useFakeTimers();

  const STELLAR_HASH = 'stellar-tx-hash-completed';

  function setupInitiate() {
    mockSchoolFindOne  = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeSchool()) });
    mockStudentFindOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(makeStudent()) });
  }

  afterEach(() => {
    stopAllAnchorPolls();
    _activePolls.clear();
    jest.clearAllTimers();
  });

  test('fires processTransaction when anchor deposit reaches completed status', async () => {
    setupInitiate();
    // Call sequence: toml → sep10 challenge → sep10 jwt → sep24 deposit → poll pending → poll completed
    mockAxiosGet
      .mockResolvedValueOnce({ data: TOML_CONTENT })
      .mockResolvedValueOnce({ data: { transaction: 'CHALLENGE', network_passphrase: 'Net' } })
      .mockResolvedValueOnce({ data: { transaction: { status: 'pending_user_transfer' } } })
      .mockResolvedValueOnce({
        data: { transaction: { status: 'completed', stellar_transaction_id: STELLAR_HASH } },
      });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { token: 'sep10-jwt' } })
      .mockResolvedValueOnce({ data: { url: INTERACTIVE_URL, id: ANCHOR_TX_ID } });

    // Horizon fetch for the completed Stellar tx
    const { server } = require('../src/config/stellarConfig');
    server.transactions().call.mockResolvedValue({ hash: STELLAR_HASH, paging_token: 'pt-1' });

    await initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, anchorId: ANCHOR_ID });

    // Run all timers to process both poll cycles
    await jest.runAllTimersAsync();

    expect(mockProcessTransaction).toHaveBeenCalledTimes(1);
    expect(_activePolls.has(ANCHOR_TX_ID)).toBe(false);
  });

  test('stops polling without calling processTransaction on error status', async () => {
    setupInitiate();
    mockAxiosGet
      .mockResolvedValueOnce({ data: TOML_CONTENT })
      .mockResolvedValueOnce({ data: { transaction: 'CHALLENGE', network_passphrase: 'Net' } })
      .mockResolvedValueOnce({ data: { transaction: { status: 'error' } } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { token: 'sep10-jwt' } })
      .mockResolvedValueOnce({ data: { url: INTERACTIVE_URL, id: ANCHOR_TX_ID } });

    await initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, anchorId: ANCHOR_ID });
    await jest.runAllTimersAsync();

    expect(mockProcessTransaction).not.toHaveBeenCalled();
    expect(_activePolls.has(ANCHOR_TX_ID)).toBe(false);
  });

  test('stops polling without calling processTransaction on refunded status', async () => {
    setupInitiate();
    mockAxiosGet
      .mockResolvedValueOnce({ data: TOML_CONTENT })
      .mockResolvedValueOnce({ data: { transaction: 'CHALLENGE', network_passphrase: 'Net' } })
      .mockResolvedValueOnce({ data: { transaction: { status: 'refunded' } } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { token: 'sep10-jwt' } })
      .mockResolvedValueOnce({ data: { url: INTERACTIVE_URL, id: ANCHOR_TX_ID } });

    await initiateAnchorDeposit({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, anchorId: ANCHOR_ID });
    await jest.runAllTimersAsync();

    expect(mockProcessTransaction).not.toHaveBeenCalled();
    expect(_activePolls.has(ANCHOR_TX_ID)).toBe(false);
  });
});
