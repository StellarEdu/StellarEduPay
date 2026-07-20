'use strict';

const crypto = require('crypto');
const { Keypair } = require('@stellar/stellar-sdk');
const { encryptSecretKey, decryptSecretKey } = require('../backend/src/utils/signerKeyManager');
const { rotateAll, validateEnv } = require('../scripts/rotate-signer-master-key');

const OLD_KEY = crypto.randomBytes(32).toString('hex');
const NEW_KEY = crypto.randomBytes(32).toString('hex');

function encryptedUnderOldKey(secret) {
  process.env.SIGNER_MASTER_KEY = OLD_KEY;
  return encryptSecretKey(secret);
}

function makeSchoolCollection(docs) {
  return {
    find: () => ({
      select: () => ({
        lean: () => Promise.resolve(docs),
      }),
    }),
    updateOne: jest.fn().mockResolvedValue({}),
  };
}

describe('validateEnv', () => {
  afterEach(() => {
    delete process.env.SIGNER_MASTER_KEY_OLD;
    delete process.env.SIGNER_MASTER_KEY;
  });

  it('throws when SIGNER_MASTER_KEY_OLD is missing', () => {
    process.env.SIGNER_MASTER_KEY = NEW_KEY;
    expect(validateEnv).toThrow(/SIGNER_MASTER_KEY_OLD/);
  });

  it('throws when SIGNER_MASTER_KEY is missing', () => {
    process.env.SIGNER_MASTER_KEY_OLD = OLD_KEY;
    expect(validateEnv).toThrow(/SIGNER_MASTER_KEY must be set/);
  });

  it('throws when old and new keys are identical', () => {
    process.env.SIGNER_MASTER_KEY_OLD = OLD_KEY;
    process.env.SIGNER_MASTER_KEY = OLD_KEY;
    expect(validateEnv).toThrow(/must differ/);
  });

  it('passes when both keys are set and differ', () => {
    process.env.SIGNER_MASTER_KEY_OLD = OLD_KEY;
    process.env.SIGNER_MASTER_KEY = NEW_KEY;
    expect(validateEnv).not.toThrow();
  });
});

describe('rotateAll', () => {
  beforeEach(() => {
    process.env.SIGNER_MASTER_KEY_OLD = OLD_KEY;
  });

  afterEach(() => {
    delete process.env.SIGNER_MASTER_KEY_OLD;
    delete process.env.SIGNER_MASTER_KEY;
  });

  it('re-encrypts every stored signing key under the new key and persists when apply=true', async () => {
    const secret = Keypair.random().secret();
    const blob = encryptedUnderOldKey(secret);
    process.env.SIGNER_MASTER_KEY = NEW_KEY; // active key going forward

    const school = { _id: 'school-1', encryptedSigningKey: blob };
    const School = makeSchoolCollection([school]);

    const results = await rotateAll(School, { apply: true });

    expect(results).toEqual([{ schoolId: 'school-1', status: 'ok' }]);
    expect(School.updateOne).toHaveBeenCalledTimes(1);

    const [filter, update] = School.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'school-1' });

    // Persisted blob must decrypt to the same secret under the NEW key only.
    process.env.SIGNER_MASTER_KEY = NEW_KEY;
    expect(decryptSecretKey(update.$set.encryptedSigningKey)).toBe(secret);
  });

  it('does not write anything when apply=false (dry run)', async () => {
    const secret = Keypair.random().secret();
    const blob = encryptedUnderOldKey(secret);
    process.env.SIGNER_MASTER_KEY = NEW_KEY;

    const School = makeSchoolCollection([{ _id: 'school-1', encryptedSigningKey: blob }]);

    const results = await rotateAll(School, { apply: false });

    expect(results).toEqual([{ schoolId: 'school-1', status: 'ok' }]);
    expect(School.updateOne).not.toHaveBeenCalled();
  });

  it('reports a per-record error without throwing when a blob is corrupt', async () => {
    process.env.SIGNER_MASTER_KEY = NEW_KEY;
    const School = makeSchoolCollection([{ _id: 'bad-school', encryptedSigningKey: 'not-a-real-blob' }]);

    const results = await rotateAll(School, { apply: true });

    expect(results).toEqual([{ schoolId: 'bad-school', status: 'error', error: expect.any(String) }]);
    expect(School.updateOne).not.toHaveBeenCalled();
  });

  it('processes multiple schools independently', async () => {
    const secretA = Keypair.random().secret();
    const blobA = encryptedUnderOldKey(secretA);
    const secretB = Keypair.random().secret();
    const blobB = encryptedUnderOldKey(secretB);
    process.env.SIGNER_MASTER_KEY = NEW_KEY;

    const School = makeSchoolCollection([
      { _id: 'a', encryptedSigningKey: blobA },
      { _id: 'b', encryptedSigningKey: blobB },
    ]);

    const results = await rotateAll(School, { apply: true });

    expect(results).toEqual([
      { schoolId: 'a', status: 'ok' },
      { schoolId: 'b', status: 'ok' },
    ]);
    expect(School.updateOne).toHaveBeenCalledTimes(2);
  });

  it('returns an empty result set when no school has a stored signing key', async () => {
    const School = makeSchoolCollection([]);
    const results = await rotateAll(School, { apply: true });
    expect(results).toEqual([]);
    expect(School.updateOne).not.toHaveBeenCalled();
  });
});
