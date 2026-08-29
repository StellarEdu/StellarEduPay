#!/usr/bin/env node
'use strict';

/**
 * Automates WEBHOOK_SECRET_ENCRYPTION_KEY rotation — the key that encrypts
 * per-school webhook secrets at rest (backend/src/services/webhookSecretEncryption.js).
 * See the "Webhook secret encryption key rotation" section of docs/security.md
 * for the full manual procedure this script drives.
 *
 * Rotation relies on the dual-key grace period built into decryptWebhookSecret():
 * set WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS to the key currently protecting
 * stored secrets and WEBHOOK_SECRET_ENCRYPTION_KEY to the new key, then run this
 * script. It decrypts each School.webhookSecret (falling back to the previous
 * key automatically) and re-encrypts it under the new key.
 *
 * Defaults to a dry run (decrypts and re-encrypts in memory for every School
 * with a webhookSecret, without writing anything) so a bad key pair is caught
 * before anything is persisted. Pass --apply to persist the re-encrypted values.
 *
 * Usage:
 *   WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS=<current key> WEBHOOK_SECRET_ENCRYPTION_KEY=<new key> \
 *     node scripts/rotate-webhook-encryption-key.js [--apply]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

const mongoose = require('mongoose');
const { encryptWebhookSecret, decryptWebhookSecret } = require('../backend/src/services/webhookSecretEncryption');

/**
 * @param {{find: Function, updateOne: Function}} School  Mongoose model (or a
 *   test double exposing the same two calls).
 * @param {{apply: boolean}} opts
 * @returns {Promise<Array<{schoolId: any, status: 'ok'|'error', error?: string}>>}
 */
async function rotateAll(School, { apply }) {
  const schools = await School.find({ webhookSecret: { $exists: true, $ne: null } })
    .select('_id webhookSecret')
    .lean();

  const results = [];
  for (const school of schools) {
    try {
      const plaintext = decryptWebhookSecret(school.webhookSecret);
      const newBlob = encryptWebhookSecret(plaintext);
      if (apply) {
        await School.updateOne({ _id: school._id }, { $set: { webhookSecret: newBlob } });
      }
      results.push({ schoolId: school._id, status: 'ok' });
    } catch (err) {
      results.push({ schoolId: school._id, status: 'error', error: err.message });
    }
  }
  return results;
}

function validateEnv() {
  const previousKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS;
  const newKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!previousKey) throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS must be set to the key currently protecting stored webhook secrets.');
  if (!newKey) throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY must be set to the new key to re-encrypt under.');
  if (previousKey === newKey) throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY and WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS must differ.');
}

async function main() {
  const apply = process.argv.includes('--apply');
  validateEnv();

  await mongoose.connect(process.env.MONGO_URI);
  const School = require('../backend/src/models/schoolModel');

  const results = await rotateAll(School, { apply });
  const failed = results.filter((r) => r.status === 'error');

  console.log(`${results.length} school(s) with a stored webhook secret found.`);
  results
    .filter((r) => r.status === 'ok')
    .forEach((r) =>
      console.log(
        `Rotated webhook secret for school: ${r.schoolId}` + (apply ? '' : ' (dry run — not persisted)')
      )
    );
  console.log(
    `${results.length - failed.length} re-encrypted successfully` +
      (apply ? '.' : ' (dry run — no writes made; re-run with --apply to persist).')
  );
  if (failed.length > 0) {
    console.error(`${failed.length} failed:`);
    failed.forEach((f) => console.error(`  - Failed to rotate webhook secret for school: ${f.schoolId}: ${f.error}`));
  }

  await mongoose.disconnect();

  if (failed.length > 0) process.exit(1);

  if (apply) {
    console.log('\nNext steps (see docs/security.md):');
    console.log('  1. Redeploy so every instance loads the new WEBHOOK_SECRET_ENCRYPTION_KEY.');
    console.log('  2. After the grace period, drop WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS from the deployment.');
    console.log('  3. Verify a test webhook delivery signs correctly, then record the rotation time and operator.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { rotateAll, validateEnv };
