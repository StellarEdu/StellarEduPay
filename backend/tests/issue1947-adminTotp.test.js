'use strict';

/**
 * #1947 — the env super-admin (break-glass) account requires a TOTP factor,
 * and each accepted TOTP step can be used only once.
 */

const speakeasy = require('speakeasy');

const mockRedis = { ready: false, client: null };

jest.mock('../src/config/redisClient', () => ({
  getRedisClient: () => mockRedis.client,
  isRedisReady: () => mockRedis.ready,
}));

jest.mock('../src/utils/logger', () => {
  const child = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
  return { child };
});

const SECRET = 'JBSWY3DPEHPK3PXP';

function currentCode(secret = SECRET) {
  return speakeasy.totp({ secret, encoding: 'base32' });
}

describe('adminTotpService (#1947)', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    mockRedis.ready = false;
    mockRedis.client = null;
    process.env.ADMIN_TOTP_SECRET = SECRET;
    service = require('../src/services/adminTotpService');
  });

  afterEach(() => {
    delete process.env.ADMIN_TOTP_SECRET;
  });

  it('reports not configured when ADMIN_TOTP_SECRET is unset', async () => {
    delete process.env.ADMIN_TOTP_SECRET;
    jest.resetModules();
    service = require('../src/services/adminTotpService');
    expect(service.isAdminTotpConfigured()).toBe(false);
    expect(await service.verifyAdminTotp(currentCode())).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('treats a blank ADMIN_TOTP_SECRET as not configured', () => {
    process.env.ADMIN_TOTP_SECRET = '   ';
    expect(service.isAdminTotpConfigured()).toBe(false);
  });

  it('rejects anything that is not six digits without consulting the secret', async () => {
    expect(await service.verifyAdminTotp(undefined)).toEqual({ ok: false, reason: 'invalid' });
    expect(await service.verifyAdminTotp('12345')).toEqual({ ok: false, reason: 'invalid' });
    expect(await service.verifyAdminTotp('abcdef')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a wrong six-digit code', async () => {
    const real = currentCode();
    const wrong = real === '000000' ? '111111' : '000000';
    expect(await service.verifyAdminTotp(wrong)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts a valid code once and rejects the same code on replay (in-process guard)', async () => {
    const code = currentCode();
    expect(await service.verifyAdminTotp(code)).toEqual({ ok: true });
    expect(await service.verifyAdminTotp(code)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('uses Redis SET NX for the replay guard when Redis is ready', async () => {
    const seen = new Set();
    mockRedis.ready = true;
    mockRedis.client = {
      set: jest.fn(async (key) => {
        if (seen.has(key)) return null;
        seen.add(key);
        return 'OK';
      }),
    };

    const code = currentCode();
    expect(await service.verifyAdminTotp(code)).toEqual({ ok: true });
    expect(await service.verifyAdminTotp(code)).toEqual({ ok: false, reason: 'replayed' });
    expect(mockRedis.client.set).toHaveBeenCalledWith(
      expect.stringMatching(/^adminTotp:used:\d+$/),
      '1',
      'EX',
      180,
      'NX'
    );
  });

  it('falls back to the in-process guard when Redis errors', async () => {
    mockRedis.ready = true;
    mockRedis.client = { set: jest.fn(async () => { throw new Error('connection reset'); }) };

    const code = currentCode();
    expect(await service.verifyAdminTotp(code)).toEqual({ ok: true });
    expect(await service.verifyAdminTotp(code)).toEqual({ ok: false, reason: 'replayed' });
  });
});
