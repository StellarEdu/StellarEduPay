'use strict';

/**
 * Tests for Issue #1814 — API keys / service accounts for school integrations.
 *
 * Contract under test:
 *  - ApiKey model stores only a hash, never the secret
 *  - Keys are created with a scope list and shown once
 *  - requireApiKey(scopes) authenticates "Authorization: Bearer sep_…"
 *    and derives schoolId from the key, never from request headers
 *  - Revoked, expired or out-of-scope keys are rejected
 *  - Keys are accepted only on /api/v1/integrations/* routes
 *  - Key create / revoke / rotate are audited
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApiKeyFindOne = jest.fn();
const mockApiKeyCreate = jest.fn();
const mockApiKeyUpdateOne = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/models/apiKeyModel', () => ({
  findOne: (...args) => mockApiKeyFindOne(...args),
  create: (...args) => mockApiKeyCreate(...args),
  updateOne: (...args) => mockApiKeyUpdateOne(...args),
}), { virtual: true });
jest.mock('../src/services/auditService', () => ({
  logAudit: (...args) => mockLogAudit(...args),
}));

const apiKeyService = require('../src/services/apiKeyService');
const { requireApiKey } = require('../src/middleware/apiKeyAuth');

const SCHOOL = 'school-1';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function activeKey(overrides = {}) {
  return {
    _id: 'key-1',
    schoolId: SCHOOL,
    prefix: 'abcd1234',
    hash: 'stored-hash',
    scopes: ['payments:read'],
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Creation and storage ──────────────────────────────────────────────────────

describe('key creation', () => {
  it('returns the secret exactly once in the sep_<prefix>_<secret> format', async () => {
    mockApiKeyCreate.mockImplementation(async (doc) => ({ _id: 'key-1', ...doc }));

    const { key, record } = await apiKeyService.createKey({
      schoolId: SCHOOL,
      name: 'ERP sync',
      scopes: ['payments:read'],
      createdBy: 'owner-1',
    });

    expect(key).toMatch(/^sep_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}$/);
    expect(record.hash).toBeDefined();
    expect(JSON.stringify(record)).not.toContain(key.split('_').pop());
  });

  it('stores scopes and creator with the record', async () => {
    mockApiKeyCreate.mockImplementation(async (doc) => ({ _id: 'key-1', ...doc }));

    await apiKeyService.createKey({
      schoolId: SCHOOL,
      name: 'SIS',
      scopes: ['students:read', 'students:write'],
      createdBy: 'owner-1',
    });

    expect(mockApiKeyCreate).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL,
      scopes: ['students:read', 'students:write'],
      createdBy: 'owner-1',
    }));
  });

  it('rejects scopes outside the allowed list', async () => {
    await expect(apiKeyService.createKey({
      schoolId: SCHOOL,
      name: 'Bad',
      scopes: ['admin:security'],
      createdBy: 'owner-1',
    })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });

  it('writes an audit entry on create', async () => {
    mockApiKeyCreate.mockImplementation(async (doc) => ({ _id: 'key-1', ...doc }));

    await apiKeyService.createKey({ schoolId: SCHOOL, name: 'A', scopes: ['payments:read'], createdBy: 'owner-1' });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'API_KEY_CREATED', schoolId: SCHOOL }));
  });
});

// ── Middleware authentication ─────────────────────────────────────────────────

describe('requireApiKey middleware', () => {
  it('accepts a valid key and sets req.schoolId from the key record', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey());
    jest.spyOn(apiKeyService, 'verifySecret').mockReturnValue(true);
    const req = {
      headers: { authorization: 'Bearer sep_abcd1234_secretsecretsecretsecretsecret', 'x-school-id': 'school-evil' },
      originalUrl: '/api/v1/integrations/payments',
    };
    const next = jest.fn();

    await requireApiKey(['payments:read'])(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.schoolId).toBe(SCHOOL);
  });

  it('ignores a spoofed school header', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey());
    jest.spyOn(apiKeyService, 'verifySecret').mockReturnValue(true);
    const req = {
      headers: { authorization: 'Bearer sep_abcd1234_secretsecretsecretsecretsecret', 'x-school-id': 'other' },
      originalUrl: '/api/v1/integrations/payments',
    };

    await requireApiKey(['payments:read'])(req, mockRes(), jest.fn());

    expect(req.schoolId).not.toBe('other');
  });

  it('rejects a revoked key', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey({ revokedAt: new Date() }));
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey(['payments:read'])({
      headers: { authorization: 'Bearer sep_abcd1234_secretsecretsecretsecretsecret' },
      originalUrl: '/api/v1/integrations/payments',
    }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired key', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey({ expiresAt: new Date('2020-01-01') }));
    const res = mockRes();

    await requireApiKey(['payments:read'])({
      headers: { authorization: 'Bearer sep_abcd1234_secretsecretsecretsecretsecret' },
      originalUrl: '/api/v1/integrations/payments',
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a key lacking the required scope with 403', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey({ scopes: ['payments:read'] }));
    jest.spyOn(apiKeyService, 'verifySecret').mockReturnValue(true);
    const res = mockRes();

    await requireApiKey(['students:write'])({
      headers: { authorization: 'Bearer sep_abcd1234_secretsecretsecretsecretsecret' },
      originalUrl: '/api/v1/integrations/students',
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects a wrong secret for a known prefix', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey());
    jest.spyOn(apiKeyService, 'verifySecret').mockReturnValue(false);
    const res = mockRes();

    await requireApiKey(['payments:read'])({
      headers: { authorization: 'Bearer sep_abcd1234_wrongwrongwrongwrongwrongwrong' },
      originalUrl: '/api/v1/integrations/payments',
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('refuses keys on admin or security routes', async () => {
    const res = mockRes();

    await requireApiKey(['payments:read'])({
      headers: { authorization: 'Bearer sep_abcd1234_secretsecretsecretsecretsecret' },
      originalUrl: '/api/admin/users',
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockApiKeyFindOne).not.toHaveBeenCalled();
  });
});

// ── Revoke and rotate ─────────────────────────────────────────────────────────

describe('revoke and rotate', () => {
  it('revoke sets revokedAt and audits the operation', async () => {
    mockApiKeyUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    await apiKeyService.revokeKey({ schoolId: SCHOOL, keyId: 'key-1', actorId: 'owner-1' });

    expect(mockApiKeyUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'key-1', schoolId: SCHOOL }),
      expect.objectContaining({ $set: expect.objectContaining({ revokedAt: expect.any(Date) }) }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'API_KEY_REVOKED' }));
  });

  it('rotate issues a new secret and revokes the old one', async () => {
    mockApiKeyFindOne.mockResolvedValue(activeKey());
    mockApiKeyCreate.mockImplementation(async (doc) => ({ _id: 'key-2', ...doc }));
    mockApiKeyUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const { key } = await apiKeyService.rotateKey({ schoolId: SCHOOL, keyId: 'key-1', actorId: 'owner-1' });

    expect(key).toMatch(/^sep_/);
    expect(mockApiKeyUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'key-1' }),
      expect.objectContaining({ $set: expect.objectContaining({ revokedAt: expect.any(Date) }) }),
    );
  });

  it('cannot revoke a key belonging to another school', async () => {
    mockApiKeyUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(apiKeyService.revokeKey({ schoolId: 'school-2', keyId: 'key-1', actorId: 'x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
