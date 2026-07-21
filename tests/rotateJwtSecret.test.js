'use strict';

const { generateSecret, parseArgs, rotate } = require('../scripts/rotate-jwt-secret');

describe('generateSecret', () => {
  it('produces a secret well above the 32-char minimum enforced by config/index.js', () => {
    expect(generateSecret().length).toBeGreaterThanOrEqual(32);
  });

  it('produces a different value on each call', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe('parseArgs', () => {
  it('defaults to secret-name=stellaredupay, deployment=backend, no namespace, confirm=false', () => {
    expect(parseArgs([])).toEqual({
      secretName: 'stellaredupay',
      deployment: 'backend',
      namespace: null,
      confirm: false,
    });
  });

  it('parses --confirm and overrides', () => {
    expect(
      parseArgs(['--confirm', '--secret-name', 'my-secret', '--deployment', 'api', '--namespace', 'prod'])
    ).toEqual({
      secretName: 'my-secret',
      deployment: 'api',
      namespace: 'prod',
      confirm: true,
    });
  });

  it('throws on an unrecognized flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('rotate', () => {
  it('patches the secret before rolling out, and rolls out before checking status', () => {
    const calls = [];
    const exec = (cmd, args) => calls.push({ cmd, args });
    const log = jest.fn();

    rotate({
      secretName: 'stellaredupay',
      deployment: 'backend',
      namespace: null,
      newSecret: 'new-secret-value',
      exec,
      log,
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['patch', 'secret', 'stellaredupay', '--type=merge', '-p', JSON.stringify({ stringData: { JWT_SECRET: 'new-secret-value' } })])
    );
    expect(calls[1].args).toEqual(expect.arrayContaining(['rollout', 'restart', 'deployment/backend']));
    expect(calls[2].args).toEqual(expect.arrayContaining(['rollout', 'status', 'deployment/backend']));
  });

  it('scopes every kubectl call to the given namespace', () => {
    const calls = [];
    const exec = (cmd, args) => calls.push(args);

    rotate({
      secretName: 'stellaredupay',
      deployment: 'backend',
      namespace: 'staging',
      newSecret: 'x',
      exec,
      log: jest.fn(),
    });

    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['-n', 'staging']);
    }
  });

  it('returns rotation metadata', () => {
    const result = rotate({
      secretName: 's',
      deployment: 'd',
      namespace: null,
      newSecret: 'x',
      exec: jest.fn(),
      log: jest.fn(),
    });

    expect(result).toMatchObject({ secretName: 's', deployment: 'd', namespace: null });
    expect(result.rotatedAt).toEqual(expect.any(String));
  });
});
