'use strict';

/**
 * Tests for Issue #1782 — /api/anchor/* is reachable without any student or
 * payment context and without rate limiting, and GET /status/:anchorTxId
 * returns deposits that belong to other schools.
 */

const express = require('express');
const request = require('supertest');

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Caller's school is taken from a header, mirroring the real resolveSchool.
jest.mock('../src/middleware/schoolContext', () => ({
  resolveSchool: (req, res, next) => {
    req.schoolId = req.get('x-school-id') || null;
    next();
  },
}));

const mockInitiateAnchorDeposit = jest.fn();
const mockFetchAnchorTxStatus = jest.fn();

jest.mock('../src/services/anchorService', () => ({
  initiateAnchorDeposit: (...a) => mockInitiateAnchorDeposit(...a),
  fetchAnchorTxStatus: (...a) => mockFetchAnchorTxStatus(...a),
  resolveAnchorConfig: jest.fn().mockResolvedValue({ homeDomain: 'anchor.example.com' }),
  listAnchorsForSchool: jest.fn().mockResolvedValue([]),
  discoverAnchorEndpoints: jest.fn().mockResolvedValue({
    sep10Url: 'https://anchor.example.com/auth',
    sep24Url: 'https://anchor.example.com/sep24',
  }),
  sep10Authenticate: jest.fn().mockResolvedValue('jwt-token'),
}));

// Deposit ownership record (issue #1781 collection).
const mockAnchorDepositFindOne = jest.fn();
jest.mock('../src/models/anchorDepositModel', () => ({
  findOne: (...a) => mockAnchorDepositFindOne(...a),
}), { virtual: true });

const anchorRoutes = require('../src/routes/anchorRoutes');

// ── Setup ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/anchor', anchorRoutes);

const PARENT_SCHOOL = 'SCH-PARENT';
const OTHER_SCHOOL = 'SCH-OTHER';

beforeAll(() => {
  process.env.ANCHOR_PLATFORM_KEYPAIR = require('@stellar/stellar-sdk').Keypair.random().secret();
});

afterAll(() => {
  delete process.env.ANCHOR_PLATFORM_KEYPAIR;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockInitiateAnchorDeposit.mockResolvedValue({
    interactiveUrl: 'https://anchor.example.com/interactive/abc',
    anchorTxId: 'anchor-tx-1',
  });
  mockFetchAnchorTxStatus.mockResolvedValue({ status: 'completed', stellar_transaction_id: 'hash' });
  mockAnchorDepositFindOne.mockReturnValue({
    lean: () => Promise.resolve({ anchorTxId: 'anchor-tx-1', schoolId: OTHER_SCHOOL }),
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #1782 — anchor route rate limiting', () => {
  test('POST /initiate from one client is rate limited after a burst of requests', async () => {
    const statuses = [];
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post('/api/anchor/initiate')
        .set('x-school-id', PARENT_SCHOOL)
        .send({ studentId: 'STU-1', anchorId: 'anchor-1' });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });
});

describe('Issue #1782 — anchor deposit status is scoped to the owning school', () => {
  test('GET /status/:anchorTxId returns 404 for a deposit owned by another school', async () => {
    const res = await request(app)
      .get('/api/anchor/status/anchor-tx-1')
      .set('x-school-id', PARENT_SCHOOL)
      .query({ sep24Url: 'https://anchor.example.com/sep24', anchorId: 'anchor-1' });

    expect(res.status).toBe(404);
    expect(mockFetchAnchorTxStatus).not.toHaveBeenCalled();
  });

  test('GET /status/:anchorTxId returns the status to the school that owns the deposit', async () => {
    mockAnchorDepositFindOne.mockReturnValue({
      lean: () => Promise.resolve({ anchorTxId: 'anchor-tx-1', schoolId: PARENT_SCHOOL }),
    });

    const res = await request(app)
      .get('/api/anchor/status/anchor-tx-1')
      .set('x-school-id', PARENT_SCHOOL)
      .query({ sep24Url: 'https://anchor.example.com/sep24', anchorId: 'anchor-1' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });
});
