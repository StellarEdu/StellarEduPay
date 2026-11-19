'use strict';

/**
 * Issue #1934 — the logger must not touch the filesystem unless LOG_TO_FILE=true.
 *
 * Kubernetes pods run with readOnlyRootFilesystem: true. Before this fix the
 * winston file transports were always attached, so every log write under a
 * read-only ./logs directory failed. These tests run the logger in a child
 * process so that LOG_TO_FILE / LOG_DIR are read fresh for each scenario.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOGGER_PATH = path.resolve(__dirname, '../src/utils/logger.js');

// Emits one info line with a correlationId, then waits so that any async
// file transport has time to flush before the child exits.
const CHILD_SCRIPT = `
  const logger = require(${JSON.stringify(LOGGER_PATH)});
  logger.info('issue1934 probe', { correlationId: 'corr_test1934', email: 'a@example.com' });
  setTimeout(() => process.exit(0), 500);
`;

function runLogger(env, cwd) {
  return spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
}

function parseJsonLines(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

describe('#1934 logger writes to stdout only by default', () => {
  let workDir;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-1934-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('emits structured JSON to stdout and creates no log directory when LOG_TO_FILE is unset', () => {
    const result = runLogger({ LOG_DIR: path.join(workDir, 'logs') }, workDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const entries = parseJsonLines(result.stdout);
    const probe = entries.find((e) => e.message === 'issue1934 probe');
    expect(probe).toBeDefined();
    expect(probe.level).toBe('INFO');
    expect(probe.args[0].correlationId).toBe('corr_test1934');
    // PII redaction is still applied on the stdout path.
    expect(probe.args[0].email).not.toBe('a@example.com');

    expect(fs.existsSync(path.join(workDir, 'logs'))).toBe(false);
  });

  it('does not error when LOG_DIR points at an unwritable location (read-only root FS)', () => {
    // A path under a regular file can never be created, which mirrors EROFS/EACCES.
    const blocker = path.join(workDir, 'not-a-directory');
    fs.writeFileSync(blocker, '');

    const result = runLogger({ LOG_DIR: path.join(blocker, 'logs') }, workDir);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/EROFS|EACCES|ENOTDIR|transport/i);
    expect(parseJsonLines(result.stdout).some((e) => e.message === 'issue1934 probe')).toBe(true);
  });

  it('writes rotating files only when LOG_TO_FILE=true', () => {
    const logDir = path.join(workDir, 'logs');

    const result = runLogger({ LOG_TO_FILE: 'true', LOG_DIR: logDir }, workDir);

    expect(result.status).toBe(0);
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir) : [];
    expect(files.some((f) => f.startsWith('combined-'))).toBe(true);
  });
});
