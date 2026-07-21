#!/usr/bin/env node
'use strict';

/**
 * Automates SIGNER_MASTER_KEY rotation — the key that encrypts Stellar
 * signing secret keys at rest (backend/src/utils/signerKeyManager.js). That
 * module already documents the correct manual procedure (set
 * SIGNER_MASTER_KEY_OLD, re-encrypt every record, persist, drop the old
 * key); this script drives it instead of a human doing it record-by-record.
 *
 * Defaults to a dry run (decrypts under the old key and re-encrypts under
 * the new one for every School with an encryptedSigningKey, without writing
 * anything) so a bad key pair is caught before anything is persisted. Pass
 * --apply to persist the re-encrypted blobs.
 *
 * Usage:
 *   SIGNER_MASTER_KEY_OLD=<current key> SIGNER_MASTER_KEY=<new key> \
 *     node scripts/rotate-signer-master-key.js [--apply]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

const mongoose = require('mongoose');
const { reEncryptSecretKey } = require('../backend/src/utils/signerKeyManager');

/**
 * @param {{find: Function, updateOne: Function}} School  Mongoose model (or a
 *   test double exposing the same two calls).
 * @param {{apply: boolean}} opts
 * @returns {Promise<Array<{schoolId: any, status: 'ok'|'error', error?: string}>>}
 */
async function rotateAll(School, { apply }) {
  const schools = await School.find({ encryptedSigningKey: { $exists: true, $ne: null } })
    .select('_id encryptedSigningKey')
    .lean();

  const results = [];
  for (const school of schools) {
    try {
      const newBlob = reEncryptSecretKey(school.encryptedSigningKey);
      if (apply) {
        await School.updateOne({ _id: school._id }, { $set: { encryptedSigningKey: newBlob } });
      }
      results.push({ schoolId: school._id, status: 'ok' });
    } catch (err) {
      results.push({ schoolId: school._id, status: 'error', error: err.message });
    }
  }
  return results;
}

function validateEnv() {
  const oldKey = process.env.SIGNER_MASTER_KEY_OLD;
  const newKey = process.env.SIGNER_MASTER_KEY;
  if (!oldKey) throw new Error('SIGNER_MASTER_KEY_OLD must be set to the key currently protecting stored records.');
  if (!newKey) throw new Error('SIGNER_MASTER_KEY must be set to the new key to re-encrypt under.');
  if (oldKey === newKey) throw new Error('SIGNER_MASTER_KEY and SIGNER_MASTER_KEY_OLD must differ.');
}

async function main() {
  const apply = process.argv.includes('--apply');
  validateEnv();

  await mongoose.connect(process.env.MONGO_URI);
  const School = require('../backend/src/models/schoolModel');

  const results = await rotateAll(School, { apply });
  const failed = results.filter((r) => r.status === 'error');

  console.log(`${results.length} school(s) with a stored signing key found.`);
  console.log(
    `${results.length - failed.length} re-encrypted successfully` +
      (apply ? '.' : ' (dry run — no writes made; re-run with --apply to persist).')
  );
  if (failed.length > 0) {
    console.error(`${failed.length} failed:`);
    failed.forEach((f) => console.error(`  - ${f.schoolId}: ${f.error}`));
  }

  await mongoose.disconnect();

  if (failed.length > 0) process.exit(1);

  if (apply) {
    console.log('\nNext steps (see docs/operator-runbooks.md):');
    console.log('  1. Update the SIGNER_MASTER_KEY secret in the deployment; drop SIGNER_MASTER_KEY_OLD.');
    console.log('  2. Redeploy API and workers.');
    console.log('  3. Verify a test decrypt/sign succeeds, then record the rotation time and operator.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { rotateAll, validateEnv };
