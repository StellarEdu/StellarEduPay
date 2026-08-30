'use strict';

/**
 * #1378: leader election emitted no Prometheus metrics, so a split brain (two
 * replicas both holding scheduler:leader after a Redis partition) was
 * undetectable from monitoring — it surfaced only as duplicate reminders and
 * doubled audit events after the fact.
 *
 * These tests drive leaderElection directly against a mocked distributed lock
 * and read the gauges off the shared registry — no Redis, no HTTP.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
mockLogger.logger = mockLogger;
mockLogger.child = jest.fn(() => mockLogger);
jest.mock('../backend/src/utils/logger', () => mockLogger);

jest.mock('../backend/src/services/distributedLock', () => ({
  acquire: jest.fn(),
  release: jest.fn().mockResolvedValue(true),
  renew: jest.fn().mockResolvedValue(true),
}));

const lock = require('../backend/src/services/distributedLock');
const leaderElection = require('../backend/src/services/leaderElection');
const {
  leaderElectionIsLeader,
  leaderElectionTenureSeconds,
} = require('../backend/src/metrics');

// === Helpers

// Gauge.get() runs the metric's collect() hook, so this is the value a scrape
// would actually see rather than whatever was last pushed.
async function gaugeValue(gauge) {
  const { values } = await gauge.get();
  return values[0]?.value;
}

async function becomeLeader() {
  lock.acquire.mockResolvedValue({ token: 'tok-1', fencingToken: 7 });
  await leaderElection.start();
}

async function becomeFollower() {
  lock.acquire.mockResolvedValue(null);
  await leaderElection.start();
}

// === Tests

describe('leader election metrics (#1378)', () => {
  afterEach(async () => {
    await leaderElection.stop();
    jest.clearAllMocks();
  });

  test('leader_election_is_leader is 0 while this instance is a follower', async () => {
    await becomeFollower();

    expect(leaderElection.isLeader()).toBe(false);
    expect(await gaugeValue(leaderElectionIsLeader)).toBe(0);
  });

  test('leader_election_is_leader is 1 once this instance wins the lock', async () => {
    await becomeLeader();

    expect(leaderElection.isLeader()).toBe(true);
    expect(await gaugeValue(leaderElectionIsLeader)).toBe(1);
  });

  test('leader_election_tenure_seconds is 0 for a follower', async () => {
    await becomeFollower();

    expect(leaderElection.getTenureSeconds()).toBe(0);
    expect(await gaugeValue(leaderElectionTenureSeconds)).toBe(0);
  });

  test('leader_election_tenure_seconds grows while leadership is held', async () => {
    await becomeLeader();

    const first = leaderElection.getTenureSeconds();
    expect(first).toBeGreaterThanOrEqual(0);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(leaderElection.getTenureSeconds()).toBeGreaterThan(first);
    expect(await gaugeValue(leaderElectionTenureSeconds)).toBeGreaterThan(0);
  });

  test('both gauges reset when leadership is given up', async () => {
    await becomeLeader();
    expect(await gaugeValue(leaderElectionIsLeader)).toBe(1);

    await leaderElection.stop();

    expect(leaderElection.getTenureSeconds()).toBe(0);
    expect(await gaugeValue(leaderElectionIsLeader)).toBe(0);
    expect(await gaugeValue(leaderElectionTenureSeconds)).toBe(0);
  });
});

describe('leader election alert rules (#1378)', () => {
  const monitoringDir = path.resolve(__dirname, '..', 'monitoring');
  const alertFile = path.join(monitoringDir, 'alerts', 'leader_election.yml');

  function loadRules() {
    return yaml.load(fs.readFileSync(alertFile, 'utf8')).groups
      .flatMap((group) => group.rules);
  }

  test('the alert file is wired into prometheus.yml rule_files', () => {
    const config = yaml.load(fs.readFileSync(path.join(monitoringDir, 'prometheus.yml'), 'utf8'));
    expect(config.rule_files).toContain('alerts/leader_election.yml');
  });

  test('a critical alert fires when more than one replica claims leadership', () => {
    const splitBrain = loadRules().find((rule) => rule.alert === 'LeaderElectionSplitBrain');

    expect(splitBrain).toBeDefined();
    expect(splitBrain.expr).toBe('sum(leader_election_is_leader) > 1');
    expect(splitBrain.labels.severity).toBe('critical');
    expect(splitBrain.annotations.summary).toBeTruthy();
    expect(splitBrain.annotations.description).toBeTruthy();
  });

  test('every rule references a metric leader election actually emits', () => {
    const rules = loadRules();

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.expr).toMatch(/leader_election_(is_leader|tenure_seconds)/);
      expect(rule.for).toBeTruthy();
    }
  });
});
