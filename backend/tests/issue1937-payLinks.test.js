'use strict';

/**
 * Tests for issue #1937 — signed pay-link tokens must be issued, accepted by a
 * public endpoint, and revocable. Covers issue → use → revoke, plus expiry,
 * tampering, unconfigured secrets and reminder-email wiring.
 */

const SECRET = 'x'.repeat(40);

const mockConfig = {
  payLinkSecret: SECRET,
  payLinkEmailLinks: true,
  APP_URL: 'https://app.example.test/',
};
jest.mock('../src/config', () => mockConfig);

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

jest.mock('../src/services/auditService', () => ({
  logAudit: jest.fn(() => Promise.resolve()),
}));

// In-memory records the mocked models read and write.
const mockDb = { student: null, school: null };

function mockChain(getValue) {
  const q = {
    select: () => q,
    lean: async () => (getValue() ? { ...getValue() } : null),
  };
  return q;
}

jest.mock('../src/models/studentModel', () => ({
  findOne: jest.fn((filter) => mockChain(() => {
    const s = mockDb.student;
    if (!s || s.schoolId !== filter.schoolId || s.studentId !== filter.studentId) return null;
    if (filter.deletedAt === null && s.deletedAt) return null;
    return s;
  })),
  findOneAndUpdate: jest.fn((filter, update) => ({
    lean: async () => {
      const s = mockDb.student;
      if (!s || s.schoolId !== filter.schoolId || s.studentId !== filter.studentId) return null;
      if (update.$inc && update.$inc.linkVersion) s.linkVersion = (s.linkVersion || 0) + update.$inc.linkVersion;
      return { linkVersion: s.linkVersion };
    },
  })),
}));

jest.mock('../src/models/schoolModel', () => ({
  findOne: jest.fn((filter) => mockChain(() => (mockDb.school && mockDb.school.schoolId === filter.schoolId ? mockDb.school : null))),
}));

// Route-level auth: resolve the school from the header, and treat every call as an
// authorised staff member of that school. Real auth is covered by its own suites.
jest.mock('../src/middleware/schoolContext', () => ({
  resolveSchool: (req, _res, next) => {
    req.schoolId = req.headers['x-school-id'];
    next();
  },
}));
jest.mock('../src/middleware/auth', () => ({
  requireSchoolAuth: () => (req, _res, next) => {
    req.user = { role: 'user', schoolId: req.schoolId, roles: ['staff'] };
    next();
  },
}));

const express = require('express');
const request = require('supertest');
const { verifyPayLinkToken, generatePayLinkToken } = require('../src/utils/payLinkToken');
const { buildReminderPayUrl } = require('../src/services/payLinkService');
const payLinkRoutes = require('../src/routes/payLinkRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', payLinkRoutes);
  return app;
}

const SCHOOL_ID = 'SCH-TEST0001';
const STUDENT_ID = 'STU-0001';

beforeEach(() => {
  mockConfig.payLinkSecret = SECRET;
  mockConfig.payLinkEmailLinks = true;
  mockDb.school = { schoolId: SCHOOL_ID, name: 'Test School', stellarAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', isActive: true };
  mockDb.student = {
    schoolId: SCHOOL_ID,
    studentId: STUDENT_ID,
    name: 'Jane Doe Smith',
    class: 'JSS1',
    feeAmount: 100,
    fees: [{ category: 'tuition', amount: 100, paid: false, totalPaid: 40 }],
    linkVersion: 0,
    deletedAt: null,
  };
});

function tokenFromUrl(url) {
  return url.slice(url.indexOf('/pay/link/') + '/pay/link/'.length);
}

describe('issue #1937 — signed pay links', () => {
  test('issue → use: a staff-issued link opens the public pay payload without a student ID in the URL', async () => {
    const app = buildApp();

    const issued = await request(app)
      .post(`/api/students/${STUDENT_ID}/pay-link`)
      .set('x-school-id', SCHOOL_ID)
      .send({});
    expect(issued.status).toBe(201);
    expect(issued.body.url).toMatch(/^https:\/\/app\.example\.test\/pay\/link\/[^/]+$/);
    expect(issued.body.url).not.toContain(STUDENT_ID);
    expect(Date.parse(issued.body.expiresAt)).toBeGreaterThan(Date.now());
    expect(issued.headers['cache-control']).toBe('no-store');

    const token = tokenFromUrl(issued.body.url);
    expect(verifyPayLinkToken(token, SECRET)).toMatchObject({ valid: true, schoolId: SCHOOL_ID, studentId: STUDENT_ID, linkVersion: 0 });

    const used = await request(app).get(`/api/pay/${token}`);
    expect(used.status).toBe(200);
    expect(used.body).toMatchObject({
      schoolName: 'Test School',
      walletAddress: mockDb.school.stellarAddress,
      memo: STUDENT_ID,
      memoType: 'text',
      maskedName: 'J*** S.',
      class: 'JSS1',
      feeAmount: 100,
    });
    expect(used.body.fees[0]).toMatchObject({ category: 'tuition', remainingBalance: '60.0000000' });
    // The student ID is only the memo; no other field echoes it back.
    expect(JSON.stringify({ ...used.body, memo: undefined })).not.toContain(STUDENT_ID);
  });

  test('revoke: links issued before a revoke are rejected with PAY_LINK_REVOKED', async () => {
    const app = buildApp();
    const issued = await request(app).post(`/api/students/${STUDENT_ID}/pay-link`).set('x-school-id', SCHOOL_ID).send({});
    const token = tokenFromUrl(issued.body.url);
    expect((await request(app).get(`/api/pay/${token}`)).status).toBe(200);

    const revoked = await request(app).post(`/api/students/${STUDENT_ID}/pay-link/revoke`).set('x-school-id', SCHOOL_ID);
    expect(revoked.status).toBe(200);
    expect(revoked.body.linkVersion).toBe(1);

    const after = await request(app).get(`/api/pay/${token}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('PAY_LINK_REVOKED');

    // A link issued after the revoke works again.
    const reissued = await request(app).post(`/api/students/${STUDENT_ID}/pay-link`).set('x-school-id', SCHOOL_ID).send({});
    expect((await request(app).get(`/api/pay/${tokenFromUrl(reissued.body.url)}`)).status).toBe(200);
  });

  test('expired links return 401 PAY_LINK_EXPIRED', async () => {
    const app = buildApp();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = generatePayLinkToken({ schoolId: SCHOOL_ID, studentId: STUDENT_ID, linkVersion: 0, expiresInSeconds: 60 }, SECRET, past);
    const res = await request(app).get(`/api/pay/${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PAY_LINK_EXPIRED');
  });

  test('tampered or foreign tokens return 401 PAY_LINK_INVALID', async () => {
    const app = buildApp();
    const issued = await request(app).post(`/api/students/${STUDENT_ID}/pay-link`).set('x-school-id', SCHOOL_ID).send({});
    const token = tokenFromUrl(issued.body.url);
    const [payload, sig] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ s: SCHOOL_ID, t: 'STU-9999', v: 0, e: 9999999999 })).toString('base64url');

    expect((await request(app).get(`/api/pay/${forgedPayload}.${sig}`)).body.code).toBe('PAY_LINK_INVALID');
    expect((await request(app).get(`/api/pay/${payload}.AAAA`)).body.code).toBe('PAY_LINK_INVALID');
    expect((await request(app).get('/api/pay/not-a-token')).body.code).toBe('PAY_LINK_INVALID');

    const signedWithOtherKey = generatePayLinkToken({ schoolId: SCHOOL_ID, studentId: STUDENT_ID }, 'y'.repeat(40));
    expect((await request(app).get(`/api/pay/${signedWithOtherKey}`)).body.code).toBe('PAY_LINK_INVALID');
  });

  test('a valid token for a student that no longer exists returns 401 PAY_LINK_INVALID', async () => {
    const app = buildApp();
    const issued = await request(app).post(`/api/students/${STUDENT_ID}/pay-link`).set('x-school-id', SCHOOL_ID).send({});
    mockDb.student = null;
    const res = await request(app).get(`/api/pay/${tokenFromUrl(issued.body.url)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PAY_LINK_INVALID');
  });

  test('issuing without PAY_LINK_SECRET returns 503 PAY_LINK_NOT_CONFIGURED', async () => {
    mockConfig.payLinkSecret = null;
    const app = buildApp();
    const res = await request(app).post(`/api/students/${STUDENT_ID}/pay-link`).set('x-school-id', SCHOOL_ID).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAY_LINK_NOT_CONFIGURED');
  });

  test('issuing for an unknown student returns 404 and does not mint a link', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/students/STU-NOPE/pay-link').set('x-school-id', SCHOOL_ID).send({});
    expect(res.status).toBe(404);
    expect(res.body.url).toBeUndefined();
  });

  test('rejects an expiry outside 1 second to 90 days', async () => {
    const app = buildApp();
    const tooLong = await request(app).post(`/api/students/${STUDENT_ID}/pay-link`).set('x-school-id', SCHOOL_ID)
      .send({ expiresInSeconds: 91 * 24 * 3600 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('VALIDATION_ERROR');
  });

  test('rejects a malformed studentId before touching the database', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/students/bad%20id!/pay-link').set('x-school-id', SCHOOL_ID).send({});
    expect(res.status).toBe(400);
  });
});

describe('issue #1937 — reminder email pay link', () => {
  test('returns an empty string unless PAY_LINK_EMAIL_LINKS is enabled', async () => {
    mockConfig.payLinkEmailLinks = false;
    await expect(buildReminderPayUrl({ schoolId: SCHOOL_ID, studentId: STUDENT_ID })).resolves.toBe('');
  });

  test('returns a usable link when enabled', async () => {
    const url = await buildReminderPayUrl({ schoolId: SCHOOL_ID, studentId: STUDENT_ID });
    expect(url).toMatch(/^https:\/\/app\.example\.test\/pay\/link\//);
  });

  test('never throws when the link cannot be issued', async () => {
    mockDb.student = null;
    await expect(buildReminderPayUrl({ schoolId: SCHOOL_ID, studentId: STUDENT_ID })).resolves.toBe('');
  });
});
