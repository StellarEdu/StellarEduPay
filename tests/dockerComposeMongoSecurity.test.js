'use strict';
/**
 * Tests for issue #1094 — docker-compose.yml must not expose MongoDB on the
 * host by default and must not provide functional default credentials.
 *
 * Extended by issue #1363 — mongod must start with explicit --auth so any
 * container in the network is denied unauthenticated access regardless of
 * whether the --keyFile flag is also present.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const composePath = path.resolve(__dirname, '..', 'docker-compose.yml');
const composeDoc = yaml.load(fs.readFileSync(composePath, 'utf8'));

describe('#1094 docker-compose.yml MongoDB security', () => {
  const mongo = composeDoc.services && composeDoc.services.mongo;

  test('mongo service is defined', () => {
    expect(mongo).toBeDefined();
  });

  test('mongo service does NOT expose a host port by default', () => {
    // The `ports` key must be absent, empty, or not contain a host-side binding
    // for 27017. Operators who need local access should use an override file.
    const ports = mongo.ports || [];
    const exposedToHost = ports.some((p) => {
      const str = String(p);
      // Match "27017:27017", "0.0.0.0:27017:27017", "${VAR}:27017", etc.
      return /(?:^|:)27017:27017/.test(str) || /^\d+:27017$/.test(str);
    });
    expect(exposedToHost).toBe(false);
  });

  test('MONGO_INITDB_ROOT_USERNAME has no default fallback value in the compose file', () => {
    const env = mongo.environment || [];
    const usernameEntry = env.find((e) => String(e).startsWith('MONGO_INITDB_ROOT_USERNAME'));
    expect(usernameEntry).toBeDefined();
    // The :- operator provides a fallback; :? raises an error with no fallback.
    // We require :? (fail loudly) rather than :- (silent default).
    expect(String(usernameEntry)).not.toMatch(/:-/);
    expect(String(usernameEntry)).toMatch(/:?\?/);
  });

  test('MONGO_INITDB_ROOT_PASSWORD has no default fallback value in the compose file', () => {
    const env = mongo.environment || [];
    const passwordEntry = env.find((e) => String(e).startsWith('MONGO_INITDB_ROOT_PASSWORD'));
    expect(passwordEntry).toBeDefined();
    expect(String(passwordEntry)).not.toMatch(/:-/);
    expect(String(passwordEntry)).toMatch(/:?\?/);
  });

  test('backend MONGO_URI has no default credential fallbacks', () => {
    const backendEnv = (composeDoc.services.backend && composeDoc.services.backend.environment) || [];
    const mongoUri = backendEnv.find((e) => String(e).startsWith('MONGO_URI'));
    expect(mongoUri).toBeDefined();
    // Must use :? (error-out) not :- (silent fallback) for both username and password
    expect(String(mongoUri)).not.toMatch(/ROOT_USERNAME:-/);
    expect(String(mongoUri)).not.toMatch(/ROOT_PASSWORD:-/);
    expect(String(mongoUri)).toMatch(/ROOT_USERNAME:\?/);
    expect(String(mongoUri)).toMatch(/ROOT_PASSWORD:\?/);
  });

  test('backup service MONGO_URI has no default credential fallbacks', () => {
    const backupEnv = (composeDoc.services.backup && composeDoc.services.backup.environment) || [];
    const mongoUri = backupEnv.find((e) => String(e).startsWith('MONGO_URI'));
    expect(mongoUri).toBeDefined();
    expect(String(mongoUri)).not.toMatch(/ROOT_USERNAME:-/);
    expect(String(mongoUri)).not.toMatch(/ROOT_PASSWORD:-/);
    expect(String(mongoUri)).toMatch(/ROOT_USERNAME:\?/);
    expect(String(mongoUri)).toMatch(/ROOT_PASSWORD:\?/);
  });

  test('compose file does not contain the literal default password "password"', () => {
    const raw = fs.readFileSync(composePath, 'utf8');
    // Should not appear as a hardcoded value outside a comment
    const lines = raw.split('\n').filter((l) => !l.trim().startsWith('#'));
    const withDefaultPassword = lines.filter((l) => /:-password/.test(l));
    expect(withDefaultPassword).toHaveLength(0);
  });

  test('compose file does not contain the literal default username "root" as a fallback', () => {
    const raw = fs.readFileSync(composePath, 'utf8');
    const lines = raw.split('\n').filter((l) => !l.trim().startsWith('#'));
    const withDefaultRoot = lines.filter((l) => /ROOT_USERNAME:-root/.test(l));
    expect(withDefaultRoot).toHaveLength(0);
  });

  // ── #1363 — explicit --auth flag ──────────────────────────────────────────
  // --keyFile implicitly enables auth but is easy to misread or accidentally
  // omit. Requiring --auth to be present explicitly in the entrypoint makes
  // the security intent unambiguous and catches accidental removal of either
  // flag during future edits.

  test('#1363 mongod entrypoint includes --auth flag explicitly', () => {
    // The entrypoint is an array or a string; normalise to one string for search.
    const entrypoint = mongo.entrypoint;
    const entrypointStr = Array.isArray(entrypoint)
      ? entrypoint.join(' ')
      : String(entrypoint || '');

    expect(entrypointStr).toMatch(/--auth/);
  });

  test('#1363 mongod entrypoint includes --keyFile for intra-cluster authentication', () => {
    const entrypoint = mongo.entrypoint;
    const entrypointStr = Array.isArray(entrypoint)
      ? entrypoint.join(' ')
      : String(entrypoint || '');

    expect(entrypointStr).toMatch(/--keyFile/);
  });
});
