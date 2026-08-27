'use strict';

const lock = require('./distributedLock');
const logger = require('../utils/logger').child('LeaderElection');

const LEADER_LOCK_KEY = 'scheduler:leader';
const LEADER_LOCK_TTL_MS = parseInt(process.env.LEADER_LOCK_TTL_MS, 10) || 30_000;
const LEADER_RENEW_INTERVAL_MS = parseInt(process.env.LEADER_RENEW_INTERVAL_MS, 10) || 15_000;
const LEADER_ACQUIRE_INTERVAL_MS = parseInt(process.env.LEADER_ACQUIRE_INTERVAL_MS, 10) || 10_000;

let _isLeader = false;
let _token = null;
let _fencingToken = null;
let _renewTimer = null;
let _acquireTimer = null;
let _callbacks = { onElected: [], onDemoted: [] };
let _running = false;

function register(onElected, onDemoted) {
  if (typeof onElected === 'function') _callbacks.onElected.push(onElected);
  if (typeof onDemoted === 'function') _callbacks.onDemoted.push(onDemoted);
}

async function _tryAcquire() {
  const acquired = await lock.acquire(LEADER_LOCK_KEY, LEADER_LOCK_TTL_MS);
  if (acquired && !_isLeader) {
    _isLeader = true;
    _token = acquired.token;
    _fencingToken = acquired.fencingToken;
    logger.info('Elected leader — starting leader callbacks', { fencingToken: acquired.fencingToken });
    _startRenew();
    for (const cb of _callbacks.onElected) {
      try { cb(); } catch (err) { logger.error('Leader elected callback failed', { error: err.message }); }
    }
  }
  return !!acquired;
}

async function _renew() {
  if (!_isLeader || !_token) return;
  const renewed = await lock.renew(LEADER_LOCK_KEY, _token, LEADER_LOCK_TTL_MS);
  if (!renewed) {
    logger.warn('Lost leadership — lock taken by another instance');
    _demote();
    return;
  }
}

function _demote() {
  _isLeader = false;
  _token = null;
  _fencingToken = null;
  _stopRenew();
  logger.info('Demoted from leader — stopping leader callbacks');
  for (const cb of _callbacks.onDemoted) {
    try { cb(); } catch (err) { logger.error('Leader demoted callback failed', { error: err.message }); }
  }
}

function _startRenew() {
  _stopRenew();
  _renewTimer = setInterval(_renew, LEADER_RENEW_INTERVAL_MS);
  _renewTimer.unref();
}

function _stopRenew() {
  if (_renewTimer) {
    clearInterval(_renewTimer);
    _renewTimer = null;
  }
}

function _startAcquire() {
  _stopAcquire();
  _acquireTimer = setInterval(_tryAcquire, LEADER_ACQUIRE_INTERVAL_MS);
  _acquireTimer.unref();
}

function _stopAcquire() {
  if (_acquireTimer) {
    clearInterval(_acquireTimer);
    _acquireTimer = null;
  }
}

async function start() {
  if (_running) return;
  _running = true;

  const redisEnabled = Boolean(process.env.REDIS_HOST);
  const replicaCount = parseInt(process.env.REPLICA_COUNT || '1', 10);

  if (!redisEnabled && replicaCount > 1) {
    logger.error(
      '[CRITICAL] Leader election: REDIS_HOST is not configured, but REPLICA_COUNT > 1. ' +
      'Refusing to start leader election without distributed locks. ' +
      'In a multi-replica deployment without Redis, every replica will believe it is the leader ' +
      'and all leader-only schedulers will run N times per cycle, causing duplicate reminders, ' +
      'duplicate audit logs, race conditions in reconciliation, and other data consistency issues. ' +
      'Set REDIS_HOST immediately for production deployments with multiple replicas.'
    );
    _running = false;
    throw new Error('Leader election requires Redis when REPLICA_COUNT > 1');
  }

  if (!redisEnabled && replicaCount > 1) {
    logger.warn(
      '[CRITICAL] Leader election starting without Redis in multi-replica mode. ' +
      'This is a production configuration error. All replicas will think they are the leader.'
    );
  }

  logger.info('Starting leader election', {
    redisEnabled,
    replicaCount,
    lockTtlMs: LEADER_LOCK_TTL_MS,
    renewIntervalMs: LEADER_RENEW_INTERVAL_MS,
    acquireIntervalMs: LEADER_ACQUIRE_INTERVAL_MS,
  });

  const acquired = await _tryAcquire();
  if (!acquired) {
    logger.info('Did not win initial election — will retry periodically');
  }
  _startAcquire();
}

async function stop() {
  _running = false;
  _stopAcquire();
  if (_isLeader) {
    _demote();
    if (_token) {
      await lock.release(LEADER_LOCK_KEY, _token);
      _token = null;
    }
  }
  _callbacks = { onElected: [], onDemoted: [] };
  logger.info('Leader election stopped');
}

function isLeader() {
  return _isLeader;
}

function getFencingToken() {
  return _fencingToken;
}

module.exports = {
  start,
  stop,
  isLeader,
  register,
  getFencingToken,
};
