'use strict';

/**
 * End-to-end auth session flow against the shared token store (issue #1921).
 *
 * Covers login, refresh with rotation and reuse detection, logout, listing
 * sessions, revoking a session, and the two-replica acceptance criterion:
 * a refresh token issued by one app instance is accepted by another, and
 * revoking it on one is seen by both.
 *
 * Uses the super-admin env login path, which needs no database. Redis is the
 * in-process fake, so no server is required.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890abcdef-xyz';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-password';
process.env.REDIS_HOST = 'redis.test';
process.env.NODE_ENV = 'test';

const { makeFakeRedis } = require('./helpers/fakeRedis');

// One Redis shared by every "replica" in this file. Factories below may read
// only `mock`-prefixed variables, so the state object lives under that name.
const mockRedisState = { client: makeFakeRedis() };

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});
jest.mock('../src/config/redisClient', () => ({
  getRedisClient: jest.fn(() => mockRedisState.client),
  isRedisReady: jest.fn(() => true),
}));
jest.mock('../src/cache', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../src/services/alertService', () => ({ sendAdminAlert: jest.fn() }));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

function cookieValue(res, name) {
  const call = res.cookie.mock.calls.find((c) => c[0] === name);
  return call ? call[1] : undefined;
}

// Each "replica" is a fresh copy of the controller module graph; they share Redis.
function loadReplica() {
  let controller;
  jest.isolateModules(() => {
    controller = require('../src/controllers/authController');
  });
  return controller;
}

const SUPER_ADMIN = { userId: 'super_admin', role: 'admin', roles: ['super_admin'] };

describe('auth session flow on the shared token store', () => {
  let auth;

  beforeEach(() => {
    auth = loadReplica();
  });

  test('login issues a session and refresh token that can be refreshed', async () => {
    const loginRes = mockRes();
    await auth.handleLogin({ body: { username: 'admin', password: 'correct-password' }, ip: '10.0.0.1', headers: {} }, loginRes);
    expect(loginRes.status).not.toHaveBeenCalled();
    const rt1 = cookieValue(loginRes, 'admin_refresh_token');
    expect(rt1).toEqual(expect.any(String));

    const refreshRes = mockRes();
    await auth.handleRefresh({ cookies: { admin_refresh_token: rt1 }, body: {} }, refreshRes);
    expect(refreshRes.status).not.toHaveBeenCalled();
    expect(cookieValue(refreshRes, 'admin_refresh_token')).toEqual(expect.any(String));
  });

  test('reuse detection: presenting a rotated token revokes the whole family', async () => {
    const loginRes = mockRes();
    await auth.handleLogin({ body: { username: 'admin', password: 'correct-password' }, ip: '10.0.0.2', headers: {} }, loginRes);
    const rt1 = cookieValue(loginRes, 'admin_refresh_token');

    const r1 = mockRes();
    await auth.handleRefresh({ cookies: { admin_refresh_token: rt1 }, body: {} }, r1);
    const rt2 = cookieValue(r1, 'admin_refresh_token');

    // Replay the already-rotated token.
    const replay = mockRes();
    await auth.handleRefresh({ cookies: { admin_refresh_token: rt1 }, body: {} }, replay);
    expect(replay.status).toHaveBeenCalledWith(401);
    expect(replay.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_REFRESH_TOKEN' }));

    // The legitimate newest token is now dead too, because its family was revoked.
    const r2 = mockRes();
    await auth.handleRefresh({ cookies: { admin_refresh_token: rt2 }, body: {} }, r2);
    expect(r2.status).toHaveBeenCalledWith(401);
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
  });

  test('logout revokes the refresh token family', async () => {
    const loginRes = mockRes();
    await auth.handleLogin({ body: { username: 'admin', password: 'correct-password' }, ip: '10.0.0.3', headers: {} }, loginRes);
    const rt = cookieValue(loginRes, 'admin_refresh_token');

    const logoutRes = mockRes();
    await auth.handleLogout({ cookies: { admin_refresh_token: rt }, body: {} }, logoutRes);
    expect(logoutRes.json).toHaveBeenCalledWith({ message: 'Logged out.' });

    const after = mockRes();
    await auth.handleRefresh({ cookies: { admin_refresh_token: rt }, body: {} }, after);
    expect(after.status).toHaveBeenCalledWith(401);
  });

  test('list sessions shows the login; revoke session ends it', async () => {
    const loginRes = mockRes();
    await auth.handleLogin({ body: { username: 'admin', password: 'correct-password' }, ip: '10.0.0.4', headers: {} }, loginRes);
    const rt = cookieValue(loginRes, 'admin_refresh_token');

    // Sessions from earlier tests share the same Redis, so pick this login's session.
    const { sessionId } = await auth.getStore().getToken(rt);

    const listRes = mockRes();
    await auth.handleListSessions({ user: SUPER_ADMIN }, listRes);
    const { sessions } = listRes.json.mock.calls[0][0];
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);

    const revokeRes = mockRes();
    await auth.handleRevokeSession({ params: { sessionId }, user: SUPER_ADMIN, auditContext: {} }, revokeRes);
    expect(revokeRes.json).toHaveBeenCalledWith({ message: 'Session revoked.' });

    const refreshRes = mockRes();
    await auth.handleRefresh({ cookies: { admin_refresh_token: rt }, body: {} }, refreshRes);
    expect(refreshRes.status).toHaveBeenCalledWith(401);
  });

  test('a refresh token issued by replica A is accepted by replica B; revoking on B is seen by A', async () => {
    const replicaA = loadReplica();
    const replicaB = loadReplica();

    const loginRes = mockRes();
    await replicaA.handleLogin({ body: { username: 'admin', password: 'correct-password' }, ip: '10.0.0.5', headers: {} }, loginRes);
    const rt = cookieValue(loginRes, 'admin_refresh_token');

    const refreshOnB = mockRes();
    await replicaB.handleRefresh({ cookies: { admin_refresh_token: rt }, body: {} }, refreshOnB);
    expect(refreshOnB.status).not.toHaveBeenCalled();
    const rtAfterB = cookieValue(refreshOnB, 'admin_refresh_token');

    // Revoke everything for the super admin through replica B.
    const { revokeAllUserSessions } = require('../src/services/sessionStore');
    await revokeAllUserSessions('super_admin');

    const refreshOnA = mockRes();
    await replicaA.handleRefresh({ cookies: { admin_refresh_token: rtAfterB }, body: {} }, refreshOnA);
    expect(refreshOnA.status).toHaveBeenCalledWith(401);
  });

  test('store unavailable in production returns 503 TOKEN_STORE_UNAVAILABLE on refresh', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const previousClient = mockRedisState.client;
      mockRedisState.client = { ...previousClient, status: 'connecting' };
      try {
        const replica = loadReplica();
        const res = mockRes();
        await replica.handleRefresh({ cookies: { admin_refresh_token: 'anything' }, body: {} }, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_STORE_UNAVAILABLE' }));
      } finally {
        mockRedisState.client = previousClient;
      }
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
