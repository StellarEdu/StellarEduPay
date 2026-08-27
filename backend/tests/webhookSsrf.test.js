'use strict';

jest.mock('dns', () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

const dns = require('dns').promises;
const { validateWebhookUrl, validateResolvedIp, isPrivateIPv4, isPrivateIPv6 } = require('../src/utils/validateWebhookUrl');

function mockDns(v4 = [], v6 = []) {
  dns.resolve4.mockResolvedValue(v4);
  dns.resolve6.mockResolvedValue(v6);
}

beforeEach(() => jest.clearAllMocks());

describe('validateWebhookUrl — protocol', () => {
  test('rejects http://', async () => {
    const r = await validateWebhookUrl('http://example.com/hook');
    expect(r.valid).toBe(false);
  });
  test('accepts https:// resolving to public IP', async () => {
    mockDns(['93.184.216.34']);
    const r = await validateWebhookUrl('https://example.com/hook');
    expect(r.valid).toBe(true);
    expect(r.resolvedIps).toContain('93.184.216.34');
  });
});

describe('validateWebhookUrl — internal hostnames', () => {
  test.each([
    ['https://localhost/hook'],
    ['https://mongo.local/hook'],
    ['https://redis.internal/hook'],
    ['https://test.localhost/hook'],
    ['https://example.test/hook'],
    ['https://foo.invalid/hook'],
  ])('rejects %s', async (url) => {
    const r = await validateWebhookUrl(url);
    expect(r.valid).toBe(false);
  });
});

describe('validateWebhookUrl — private IP literals', () => {
  test.each([
    ['https://127.0.0.1/hook'],
    ['https://10.0.0.1/hook'],
    ['https://172.16.0.1/hook'],
    ['https://192.168.1.1/hook'],
    ['https://169.254.169.254/hook'],
  ])('rejects %s', async (url) => {
    const r = await validateWebhookUrl(url);
    expect(r.valid).toBe(false);
  });
});

describe('validateWebhookUrl — DNS resolution', () => {
  test('rejects hostname resolving to RFC 1918', async () => {
    mockDns(['192.168.100.5']);
    const r = await validateWebhookUrl('https://evil.example.com/hook');
    expect(r.valid).toBe(false);
  });
  test('rejects when DNS returns no addresses', async () => {
    mockDns([], []);
    const r = await validateWebhookUrl('https://nonexistent.example.com/hook');
    expect(r.valid).toBe(false);
  });
  test('accepts public IP from DNS', async () => {
    mockDns(['93.184.216.34']);
    const r = await validateWebhookUrl('https://example.com/hook');
    expect(r.valid).toBe(true);
  });
});

describe('validateResolvedIp', () => {
  test.each([
    ['10.0.0.1', true],
    ['172.16.5.5', true],
    ['192.168.0.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('IPv4 %s → blocked: %s', (ip, expected) => {
    expect(validateResolvedIp(ip).blocked).toBe(expected);
  });

  test.each([
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['::ffff:192.168.1.1', true],
    ['2001:db8::1', false],
  ])('IPv6 %s → blocked: %s', (ip, expected) => {
    expect(validateResolvedIp(ip).blocked).toBe(expected);
  });
});

describe('isPrivateIPv4 helper', () => {
  test.each([
    ['127.0.0.1', true], ['10.0.0.1', true], ['172.16.0.1', true],
    ['172.31.255.255', true], ['192.168.0.1', true], ['169.254.1.1', true],
    ['8.8.8.8', false], ['93.184.216.34', false],
  ])('%s → %s', (ip, exp) => expect(isPrivateIPv4(ip)).toBe(exp));
});

describe('isPrivateIPv6 helper', () => {
  test('::1 is private', () => expect(isPrivateIPv6('::1')).toBe(true));
  test('fe80::1 is private', () => expect(isPrivateIPv6('fe80::1')).toBe(true));
  test('fc00::1 is private', () => expect(isPrivateIPv6('fc00::1')).toBe(true));
  test('2001:db8::1 is public', () => expect(isPrivateIPv6('2001:db8::1')).toBe(false));
});

describe('DNS rebinding attack (Issue #1332)', () => {
  test('catches post-registration DNS change to private IP', async () => {
    const hostname = 'attacker.example.com';

    // Initial registration: DNS resolves to public IP
    mockDns(['93.184.216.34']);
    const r1 = await validateWebhookUrl(`https://${hostname}/hook`);
    expect(r1.valid).toBe(true);
    expect(r1.resolvedIps).toContain('93.184.216.34');

    // Later: attacker changes DNS to point to private IP
    mockDns(['192.168.1.100']);
    const r2 = await validateWebhookUrl(`https://${hostname}/hook`);
    expect(r2.valid).toBe(false);
  });

  test('detects rebinding to localhost on delivery retry', async () => {
    const hostname = 'rebind.example.com';

    // First validation: public IP
    mockDns(['1.2.3.4']);
    const r1 = await validateWebhookUrl(`https://${hostname}/hook`);
    expect(r1.valid).toBe(true);

    // Attacker rebinds: second validation on delivery returns private IP
    mockDns(['127.0.0.1']);
    const r2 = await validateWebhookUrl(`https://${hostname}/hook`);
    expect(r2.valid).toBe(false);
  });

  test('catches rebinding to AWS metadata service', async () => {
    const hostname = 'compromised.example.com';

    mockDns(['1.1.1.1']);
    const r1 = await validateWebhookUrl(`https://${hostname}/hook`);
    expect(r1.valid).toBe(true);

    // Rebind to AWS metadata service (169.254.169.254)
    mockDns(['169.254.169.254']);
    const r2 = await validateWebhookUrl(`https://${hostname}/hook`);
    expect(r2.valid).toBe(false);
  });
});
