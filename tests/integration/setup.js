'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

beforeAll(async () => {
  if (globalThis.__stellarIntegration) return;
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri('stellaredupay_integration');
  process.env.MONGO_URI = uri;
  globalThis.__stellarIntegration = { replSet, uri };
  await mongoose.connect(uri, { dbName: 'stellaredupay_integration' });

  // Loading every model here exercises the same plugins, validators and index
  // declarations used by the application instead of test doubles.
  const fs = require('fs');
  const path = require('path');
  const modelsDir = path.resolve(__dirname, '../../backend/src/models');
  for (const file of fs.readdirSync(modelsDir).filter((name) => name.endsWith('.js')).sort()) {
    require(path.join(modelsDir, file));
  }
  const { runMigrations } = require('../../backend/src/services/migrationRunner');
  await runMigrations(require, mongoose.connection.db);
  await mongoose.connection.syncIndexes();
}, 120000);

afterAll(async () => {
  if (!globalThis.__stellarIntegration) return;
  await mongoose.disconnect();
  await globalThis.__stellarIntegration.replSet.stop();
  delete globalThis.__stellarIntegration;
});
