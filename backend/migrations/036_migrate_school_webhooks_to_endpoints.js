'use strict';

/**
 * Migration 036 — Convert School.webhookUrl into WebhookEndpoint documents.
 *
 * Issue #1640: outbound webhooks could be configured two ways — the legacy
 * per-school School.webhookUrl / School.webhookSecret, and the multi-endpoint
 * WebhookEndpoint model. WebhookEndpoint is now the only system and the legacy
 * delivery branch has been removed from webhookService.
 *
 * For every school with a webhookUrl this migration:
 *   1. Creates a WebhookEndpoint (source = 'legacy_school_webhook') with the
 *      same URL, subscribed to the events the legacy path emitted, receiving
 *      the same v1 + v2 signatures.
 *   2. Carries over the signing secret — decrypted with the current
 *      WEBHOOK_SECRET_ENCRYPTION_KEY and re-encrypted for the endpoint. A
 *      school that had a URL but no secret (unsigned deliveries) gets a new
 *      generated secret; receivers that never verified signatures are
 *      unaffected, and the secret can be obtained by rotating it.
 *   3. Re-points pending legacy retries (endpointId = null) at the new
 *      endpoint so they are still signed when they are retried.
 *   4. Unsets School.webhookUrl and School.webhookSecret.
 *
 * Per-school payload filtering (School.webhookPayloadConfig) is unchanged: it
 * already applies to every WebhookEndpoint delivery of the school.
 *
 * Idempotent: a school that already has a legacy endpoint is not converted
 * again (its leftover School fields are still unset).
 *
 * Rollback:
 *   down() copies each legacy endpoint's URL and (still encrypted) secret back
 *   onto its School and deletes the endpoint. Only meaningful together with a
 *   code rollback, since the current code no longer reads the School fields.
 */

const VERSION = '036_migrate_school_webhooks_to_endpoints';

const SOURCE = 'legacy_school_webhook';

// Mirrors LEGACY_SCHOOL_EVENTS in src/models/webhookEndpointModel.js, frozen
// here so the migration's behaviour does not change if that list does.
const LEGACY_EVENTS = [
  'payment.confirmed',
  'payment.refunded',
  'dispute.created',
  'dispute.under_review',
  'dispute.resolved',
  'dispute.reopened',
];

function _crypto() {
  return require('../src/services/webhookSecretEncryption');
}

async function up(db) {
  const { encryptWebhookSecret, decryptWebhookSecret } = _crypto();
  const { generateWebhookSecret } = require('../src/utils/webhookSecretPolicy');

  const schools = db.collection('schools');
  const endpoints = db.collection('webhookendpoints');
  const retries = db.collection('webhookretries');

  const cursor = schools.find({
    $or: [
      { webhookUrl: { $type: 'string', $ne: '' } },
      { webhookSecret: { $exists: true } },
    ],
  });

  let converted = 0;
  let generatedSecrets = 0;
  let retriesRepointed = 0;
  let skipped = 0;

  for await (const school of cursor) {
    const url = typeof school.webhookUrl === 'string' ? school.webhookUrl.trim() : '';

    if (url) {
      const existing = await endpoints.findOne({ schoolId: school.schoolId, source: SOURCE });
      let endpointId = existing ? existing._id : null;

      if (!existing) {
        let plaintext = null;
        if (typeof school.webhookSecret === 'string' && school.webhookSecret.length > 0) {
          // If the value cannot be decrypted (key not configured here), the
          // ciphertext is returned unchanged and encryptWebhookSecret() below
          // passes it through, so it is carried over still encrypted under the
          // same key that both collections share.
          plaintext = decryptWebhookSecret(school.webhookSecret);
        }
        if (!plaintext) {
          plaintext = generateWebhookSecret();
          generatedSecrets++;
        }

        const now = new Date();
        const result = await endpoints.insertOne({
          schoolId: school.schoolId,
          url,
          secret: encryptWebhookSecret(plaintext),
          previousSecret: null,
          previousSecretExpiresAt: null,
          secretRotatedAt: null,
          signatureVersions: ['v1', 'v2'],
          subscribedEvents: [...LEGACY_EVENTS],
          isActive: school.isActive !== false,
          description: 'School webhook (migrated from School.webhookUrl)',
          createdBy: 'migration:036',
          source: SOURCE,
          createdAt: now,
          updatedAt: now,
        });
        endpointId = result.insertedId;
        converted++;
      } else {
        skipped++;
      }

      const repointed = await retries.updateMany(
        {
          schoolId: school.schoolId,
          url,
          endpointId: null,
          status: { $in: ['pending', 'processing'] },
        },
        { $set: { endpointId } }
      );
      retriesRepointed += repointed.modifiedCount || 0;
    }

    await schools.updateOne(
      { _id: school._id },
      { $unset: { webhookUrl: '', webhookSecret: '' } }
    );
  }

  await endpoints.createIndex({ schoolId: 1, source: 1 });

  console.log(
    `[Migration 036] Converted ${converted} school webhook(s) to WebhookEndpoint ` +
    `(${skipped} already converted, ${generatedSecrets} without a secret got a generated one); ` +
    `re-pointed ${retriesRepointed} pending retr${retriesRepointed === 1 ? 'y' : 'ies'}.`
  );
}

async function down(db) {
  const schools = db.collection('schools');
  const endpoints = db.collection('webhookendpoints');

  let restored = 0;
  const cursor = endpoints.find({ source: SOURCE });
  for await (const ep of cursor) {
    // The secret stays encrypted with the same key, which is exactly how
    // School.webhookSecret was stored.
    await schools.updateOne(
      { schoolId: ep.schoolId },
      { $set: { webhookUrl: ep.url, webhookSecret: ep.secret || null } }
    );
    await endpoints.deleteOne({ _id: ep._id });
    restored++;
  }

  try {
    await endpoints.dropIndex('schoolId_1_source_1');
  } catch (_) {
    // Index may not exist — nothing to drop.
  }

  console.log(`[Migration 036] Rolled back. Restored ${restored} school webhook(s) from WebhookEndpoint.`);
}

module.exports = { version: VERSION, up, down };
