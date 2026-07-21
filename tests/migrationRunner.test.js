const path = require('path');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockDeleteOne = jest.fn();

jest.mock('../backend/src/models/migrationModel', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  findOne: (...args) => mockFindOne(...args),
  deleteOne: (...args) => mockDeleteOne(...args),
}));

jest.mock('fs', () => ({
  existsSync: () => true,
  readdirSync: () => mockFiles,
}));

// Mock the logger so winston's DailyRotateFile file transport never loads. With
// fs stubbed above, letting winston initialise sends its log-rotation logic
// (readdirSync/existsSync/mkdirSync on the log dir) into a CPU-bound infinite
// loop that hangs the whole suite. The runner only logs progress, so a no-op
// logger is sufficient here.
jest.mock('../backend/src/utils/logger', () => {
  const noop = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
  return { child: noop, ...noop() };
});

let mockFiles = [];

const { runMigrations, rollback } = require('../backend/src/services/migrationRunner');

const MIGRATIONS_DIR = path.resolve(__dirname, '../backend/migrations');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequire(files) {
  const map = Object.fromEntries(
    files.map(f => [path.join(MIGRATIONS_DIR, f.name), f.module])
  );
  return id => {
    if (map[id]) return map[id];
    throw new Error(`Unexpected require: ${id}`);
  };
}

// null return → lock acquired (document was inserted)
const LOCK_ACQUIRED = null;
// non-null return → lock already held by another instance
const LOCK_HELD = { version: 'already-exists' };

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: lock is always available
  mockFindOneAndUpdate.mockResolvedValue(LOCK_ACQUIRED);
  mockDeleteOne.mockResolvedValue({});
});

describe('runMigrations — distributed locking', () => {
  test('acquires lock via findOneAndUpdate upsert before running migration', async () => {
    const up = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map(f => f.name);

    await runMigrations(makeRequire(files));

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { version: '001_test' },
      { $setOnInsert: expect.objectContaining({ version: '001_test', lockedAt: expect.any(Date) }) },
      { upsert: true, new: false }
    );
    expect(up).toHaveBeenCalledTimes(1);
  });

  test('runs migration when lock is acquired (findOneAndUpdate returns null)', async () => {
    mockFindOneAndUpdate.mockResolvedValue(LOCK_ACQUIRED);
    const up = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map(f => f.name);

    await runMigrations(makeRequire(files));

    expect(up).toHaveBeenCalledTimes(1);
  });

  test('skips migration when lock is already held (findOneAndUpdate returns existing doc)', async () => {
    mockFindOneAndUpdate.mockResolvedValue(LOCK_HELD);
    const up = jest.fn();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map(f => f.name);

    await runMigrations(makeRequire(files));

    expect(up).not.toHaveBeenCalled();
  });

  test('concurrent simulation: only the instance that wins the upsert runs the migration', async () => {
    const up = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map(f => f.name);

    // Instance A wins the lock, instance B loses
    mockFindOneAndUpdate
      .mockResolvedValueOnce(LOCK_ACQUIRED)  // instance A
      .mockResolvedValueOnce(LOCK_HELD);     // instance B

    await Promise.all([
      runMigrations(makeRequire(files)),
      runMigrations(makeRequire(files)),
    ]);

    // Migration should only run once despite two concurrent attempts
    expect(up).toHaveBeenCalledTimes(1);
  });

  test('runs migrations in sorted filename order', async () => {
    const order = [];
    const files = [
      { name: '002_b.js', module: { version: '002_b', up: async () => order.push('002') } },
      { name: '001_a.js', module: { version: '001_a', up: async () => order.push('001') } },
    ];
    mockFiles = files.map(f => f.name);

    await runMigrations(makeRequire(files));

    expect(order).toEqual(['001', '002']);
  });

  test('skips already-locked migrations and runs pending ones', async () => {
    // 001 already locked (applied by another instance), 002 is pending
    mockFindOneAndUpdate
      .mockResolvedValueOnce(LOCK_HELD)     // 001 — skip
      .mockResolvedValueOnce(LOCK_ACQUIRED); // 002 — run

    const up1 = jest.fn();
    const up2 = jest.fn().mockResolvedValue();
    const files = [
      { name: '001_a.js', module: { version: '001_a', up: up1 } },
      { name: '002_b.js', module: { version: '002_b', up: up2 } },
    ];
    mockFiles = files.map(f => f.name);

    await runMigrations(makeRequire(files));

    expect(up1).not.toHaveBeenCalled();
    expect(up2).toHaveBeenCalledTimes(1);
  });

  test('does nothing when migrations directory does not exist', async () => {
    jest.resetModules();
    jest.mock('fs', () => ({ existsSync: () => false, readdirSync: jest.fn() }));
    const { runMigrations: run } = require('../backend/src/services/migrationRunner');
    await run();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not call findOneAndUpdate when no migration files exist', async () => {
    mockFiles = [];
    await runMigrations(makeRequire([]));
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('runMigrations — failed up cleans up lock', () => {
  test('deletes the lock document when up() throws so the migration is not skipped on retry', async () => {
    const up = jest.fn().mockRejectedValue(new Error('up failed'));
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map(f => f.name);

    await expect(runMigrations(makeRequire(files))).rejects.toThrow('up failed');

    expect(mockDeleteOne).toHaveBeenCalledWith({ version: '001_test' });
  });
});

describe('rollback', () => {
  test('calls down() of the last applied migration and deletes its record', async () => {
    const down = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up: jest.fn(), down } }];
    mockFiles = files.map(f => f.name);

    // Simulate findOne().sort() chain returning the last applied migration
    mockFindOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({ version: '001_test', appliedAt: new Date() }),
    });

    await rollback(makeRequire(files));

    expect(down).toHaveBeenCalledTimes(1);
    expect(mockDeleteOne).toHaveBeenCalledWith({ version: '001_test' });
  });

  test('does nothing when no migrations have been applied', async () => {
    mockFindOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });

    await rollback(makeRequire([])); // should not throw

    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  test('throws when the migration file has no down() function', async () => {
    const files = [{ name: '001_test.js', module: { version: '001_test', up: jest.fn() } }];
    mockFiles = files.map(f => f.name);

    mockFindOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({ version: '001_test', appliedAt: new Date() }),
    });

    await expect(rollback(makeRequire(files))).rejects.toThrow(/down/);
  });

  test('throws when the migration file for the last version cannot be found', async () => {
    mockFiles = []; // no files on disk

    mockFindOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({ version: '001_missing', appliedAt: new Date() }),
    });

    await expect(rollback(makeRequire([]))).rejects.toThrow(/not found/);
  });
});
