'use strict';

/**
 * Tests for migrationRunner.js
 *
 * Verifies:
 * 1. All migrations run idempotently
 * 2. Runner skips already-applied migrations
 * 3. Failed migration does not mark itself as applied (lock is removed)
 */

const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Register models
require('../backend/src/models/migrationModel');

const { runMigrations } = require('../backend/src/services/migrationRunner');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Migration Runner', () => {
  beforeEach(async () => {
    await mongoose.connection.collection('migrations').deleteMany({});
  });

  test('should run pending migrations in version order', async () => {
    const mockMigrations = [
      {
        version: '001',
        up: jest.fn().mockResolvedValue(undefined),
      },
      {
        version: '002',
        up: jest.fn().mockResolvedValue(undefined),
      },
    ];

    const mockRequire = jest.fn((modulePath) => {
      const fileName = path.basename(modulePath);
      return mockMigrations.find(m => fileName.includes(m.version)) || {};
    });

    const mockFs = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['001.js', '002.js']),
    };

    jest.doMock('fs', () => mockFs, { virtual: true });

    await runMigrations(mockRequire, mongoose.connection.db);

    expect(mockMigrations[0].up).toHaveBeenCalled();
    expect(mockMigrations[1].up).toHaveBeenCalled();

    const Migration = mongoose.model('Migration');
    const applied = await Migration.find({}).lean();
    expect(applied).toHaveLength(2);
    expect(applied[0].version).toBe('001');
    expect(applied[1].version).toBe('002');
  });

  test('should skip already-applied migrations', async () => {
    const Migration = mongoose.model('Migration');

    // Pre-insert a migration record
    await Migration.create({
      version: '001',
      appliedAt: new Date(),
    });

    const mockMigrations = [
      {
        version: '001',
        up: jest.fn().mockResolvedValue(undefined),
      },
      {
        version: '002',
        up: jest.fn().mockResolvedValue(undefined),
      },
    ];

    const mockRequire = jest.fn((modulePath) => {
      const fileName = path.basename(modulePath);
      return mockMigrations.find(m => fileName.includes(m.version)) || {};
    });

    const mockFs = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['001.js', '002.js']),
    };

    jest.doMock('fs', () => mockFs, { virtual: true });

    await runMigrations(mockRequire, mongoose.connection.db);

    // Migration 001 should NOT be called (already applied)
    expect(mockMigrations[0].up).not.toHaveBeenCalled();
    // Migration 002 should be called
    expect(mockMigrations[1].up).toHaveBeenCalled();
  });

  test('should not mark failed migration as applied and should remove lock', async () => {
    const Migration = mongoose.model('Migration');
    const error = new Error('Migration failed');

    const mockMigrations = [
      {
        version: '001',
        up: jest.fn().mockRejectedValue(error),
      },
    ];

    const mockRequire = jest.fn((modulePath) => {
      const fileName = path.basename(modulePath);
      return mockMigrations.find(m => fileName.includes(m.version)) || {};
    });

    const mockFs = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['001.js']),
    };

    jest.doMock('fs', () => mockFs, { virtual: true });

    await expect(
      runMigrations(mockRequire, mongoose.connection.db)
    ).rejects.toThrow('Migration failed');

    // Verify the lock was removed (migration not in collection)
    const migrations = await Migration.find({}).lean();
    expect(migrations).toHaveLength(0);
  });

  test('should run same migration twice if lock is removed after failure', async () => {
    const Migration = mongoose.model('Migration');
    const error = new Error('First attempt failed');

    let callCount = 0;
    const mockMigrations = [
      {
        version: '001',
        up: jest.fn(async () => {
          callCount++;
          if (callCount === 1) throw error;
        }),
      },
    ];

    const mockRequire = jest.fn((modulePath) => {
      const fileName = path.basename(modulePath);
      return mockMigrations.find(m => fileName.includes(m.version)) || {};
    });

    const mockFs = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['001.js']),
    };

    jest.doMock('fs', () => mockFs, { virtual: true });

    // First run: migration fails and lock is removed
    await expect(
      runMigrations(mockRequire, mongoose.connection.db)
    ).rejects.toThrow('First attempt failed');

    // Second run: migration succeeds
    await runMigrations(mockRequire, mongoose.connection.db);

    // Verify the migration was called twice
    expect(mockMigrations[0].up).toHaveBeenCalledTimes(2);

    // Verify it's marked as applied
    const migrations = await Migration.find({}).lean();
    expect(migrations).toHaveLength(1);
    expect(migrations[0].appliedAt).toBeDefined();
  });

  test('should handle concurrent migration attempts (distributed locking)', async () => {
    const Migration = mongoose.model('Migration');

    const mockMigration = {
      version: '001',
      up: jest.fn(async () => {
        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10));
      }),
    };

    const mockRequire = jest.fn(() => mockMigration);

    const mockFs = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['001.js']),
    };

    jest.doMock('fs', () => mockFs, { virtual: true });

    // Simulate two concurrent runners
    const [result1, result2] = await Promise.allSettled([
      runMigrations(mockRequire, mongoose.connection.db),
      runMigrations(mockRequire, mongoose.connection.db),
    ]);

    // Both should complete (not error out)
    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('fulfilled');

    // But the migration should only run once
    expect(mockMigration.up).toHaveBeenCalledTimes(1);

    // And it should be marked as applied
    const migrations = await Migration.find({}).lean();
    expect(migrations).toHaveLength(1);
  });
});
