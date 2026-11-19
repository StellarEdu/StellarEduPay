'use strict';

/**
 * #1931 — the Docker HEALTHCHECK must build a valid /health/live URL and report
 * healthy for a live server, with or without PORT set.
 *
 * The test reads the command out of backend/Dockerfile and runs that exact
 * string, so the check cannot drift from what the image runs.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const DOCKERFILE = path.resolve(__dirname, '..', 'Dockerfile');

function healthcheckScript() {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const match = text.match(/HEALTHCHECK[^\n]*\\\n\s*CMD node -e \\\n\s*"([^"]+)"/);
  if (!match) throw new Error('HEALTHCHECK command not found in Dockerfile');
  return match[1];
}

// Async spawn: a blocking spawnSync would stop this process's event loop, and
// the stub server living in this process could never answer the probe.
function runHealthcheck(env) {
  const childEnv = { ...process.env };
  delete childEnv.PORT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', healthcheckScript()], { env: { ...childEnv, ...env } });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function startStubServer(statusCode) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/health/live' ? statusCode : 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('#1931 Docker HEALTHCHECK', () => {
  test('Dockerfile sets PORT so the probe targets the listening port', () => {
    expect(fs.readFileSync(DOCKERFILE, 'utf8')).toMatch(/^ENV PORT=5000$/m);
  });

  test('with PORT unset it targets http://127.0.0.1:5000/health/live', () => {
    // Patch http.get to record the URL instead of connecting anywhere.
    const probe = `
      const http = require('http');
      http.get = (url) => { process.stdout.write('URL:' + url); process.exit(0); };
      ${healthcheckScript()}
    `;
    const childEnv = { ...process.env };
    delete childEnv.PORT;
    const out = execFileSync(process.execPath, ['-e', probe], { env: childEnv, encoding: 'utf8' });
    expect(out).toBe('URL:http://127.0.0.1:5000/health/live');
  });

  test('exits 0 when /health/live returns 200 on PORT', async () => {
    const server = await startStubServer(200);
    try {
      const { port } = server.address();
      const status = await runHealthcheck({ PORT: String(port) });
      expect(status).toBe(0);
    } finally {
      server.close();
    }
  });

  test('exits 1 when /health/live returns a non-200 status', async () => {
    const server = await startStubServer(503);
    try {
      const { port } = server.address();
      const status = await runHealthcheck({ PORT: String(port) });
      expect(status).toBe(1);
    } finally {
      server.close();
    }
  });

  test('exits 1 when nothing is listening on PORT', async () => {
    const server = await startStubServer(200);
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const status = await runHealthcheck({ PORT: String(port) });
    expect(status).toBe(1);
  });
});
