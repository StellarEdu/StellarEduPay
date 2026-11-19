'use strict';

/**
 * #1929 — OpenTelemetry tracing must actually start when OTEL_TRACING_ENABLED=true,
 * produce spans for inbound HTTP, and never export secrets carried in query strings.
 *
 * The SDK patches http/express at require time, so the check runs in a child
 * process to keep Jest's module registry out of the way. The child uses an
 * in-memory exporter and reports the spans it captured on stdout.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SECRET = 'SUPER-SECRET-TOKEN-1929';
// Dummy values that satisfy config validation; nothing connects to them.
const DUMMY_ENV = {
  MONGO_URI: 'mongodb://127.0.0.1:1/dummy',
  JWT_SECRET: 'dummy-jwt-secret-for-tracing-test-0123456789',
  RECEIPT_SIGNATURE_SECRET: 'dummy-receipt-secret-for-tracing-test',
};

const CHILD_SCRIPT = `
  const http = require('http');
  const spans = [];
  const memoryExporter = {
    export(batch, cb) {
      for (const s of batch) spans.push({ name: s.name, attributes: { ...s.attributes } });
      cb({ code: 0 });
    },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
  };

  const tracing = require(${JSON.stringify(path.join(BACKEND_ROOT, 'src/tracing'))});
  if (!tracing.initTracing({ traceExporter: memoryExporter })) {
    process.stdout.write('SPANS:' + JSON.stringify({ error: 'tracing did not start' }) + '\\n');
    process.exit(0);
  }

  // A minimal Express app: the SDK's http/express instrumentation is what is under test,
  // and keeping app.js out of the child means unrelated modules cannot break it.
  const express = require(${JSON.stringify(require.resolve('express', { paths: [BACKEND_ROOT] }))});
  const app = express();
  app.get('/health/live', (req, res) => res.status(200).json({ status: 'alive' }));
  const server = http.createServer(app).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    http.get('http://127.0.0.1:' + port + '/health/live?token=${SECRET}', (res) => {
      res.resume();
      res.on('end', async () => {
        server.close();
        await tracing.shutdownTracing();
        process.stdout.write('SPANS:' + JSON.stringify({ status: res.statusCode, spans }) + '\\n');
        process.exit(0);
      });
    });
  });
`;

function runChild(extraEnv = {}) {
  const out = execFileSync(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      ...DUMMY_ENV,
      NODE_ENV: 'test',
      OTEL_TRACING_ENABLED: 'true',
      ...extraEnv,
    },
  });
  const line = out.split('\n').find((l) => l.startsWith('SPANS:'));
  if (!line) throw new Error(`child produced no SPANS line:\n${out}`);
  return JSON.parse(line.slice('SPANS:'.length));
}

describe('#1929 OpenTelemetry tracing', () => {
  jest.setTimeout(120000);

  let result;
  beforeAll(() => {
    result = runChild();
  });

  test('tracing starts and records a span for GET /health/live', () => {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    const serialised = JSON.stringify(result.spans);
    expect(serialised).toContain('/health/live');
    expect(result.spans.length).toBeGreaterThan(0);
  });

  test('no exported span attribute contains the token from the query string', () => {
    const serialised = JSON.stringify(result.spans);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain('[REDACTED]');
  });

  test('redactString masks secret query parameters and keeps the rest', () => {
    const { redactString } = require('../src/tracing');
    expect(redactString('/reset?token=abc&lang=en')).toBe('/reset?token=[REDACTED]&lang=en');
    expect(redactString('GET /x?password=p%20w')).toBe('GET /x?password=[REDACTED]');
    expect(redactString('/health/live')).toBe('/health/live');
  });

  test('production with a missing SDK fails fast instead of degrading silently', () => {
    const script = `
      process.env.OTEL_TRACING_ENABLED = 'true';
      process.env.NODE_ENV = 'production';
      const Module = require('module');
      const original = Module._load;
      Module._load = function (request, ...rest) {
        if (String(request).startsWith('@opentelemetry/sdk-node')) throw new Error('simulated missing SDK');
        return original.call(this, request, ...rest);
      };
      try {
        require(${JSON.stringify(path.join(BACKEND_ROOT, 'src/tracing'))}).initTracing();
        process.stdout.write('RESULT:no-throw\\n');
      } catch (err) {
        process.stdout.write('RESULT:' + err.message + '\\n');
      }
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ...DUMMY_ENV, OTEL_TRACING_ENABLED: 'true', NODE_ENV: 'production' },
    });
    expect(out).toContain('simulated missing SDK');
    expect(out).not.toContain('RESULT:no-throw');
  });
});
