'use strict';

/**
 * CoinGecko contract test + canary  (#893)
 *
 * Acceptance criteria:
 *   ✓ Fixture-based contract test for the parser:
 *       checkCoinGeckoResponseShape validates the recorded fixture and
 *       detects every documented shape deviation.
 *   ✓ Canary alerts on shape change:
 *       runCoinGeckoCanary returns { ok: false } + logs a warning when the
 *       live response does not match the contract.
 *   ✓ Documented response contract:
 *       The expected shape is documented in the fixture JSON and in the
 *       CURRENCY_DECIMALS comment block inside currencyConversionService.js.
 *
 * The contract (from the fixture and the service):
 *   GET /api/v3/simple/price?ids=stellar,usd-coin&vs_currencies=<CURRENCY>
 *   {
 *     "stellar":   { "<lc_currency>": <positive finite number> },
 *     "usd-coin":  { "<lc_currency>": <positive finite number> }
 *   }
 */

const path    = require('path');
const https   = require('https');

// ── helpers ──────────────────────────────────────────────────────────────────

function mockHttpsGet(responseBody, statusCode = 200) {
  const original = https.get;
  https.get = (_url, _opts, callback) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    const fakeRes = {
      statusCode,
      on(event, fn) {
        if (event === 'data') fn(JSON.stringify(responseBody));
        if (event === 'end')  fn();
        return this;
      },
    };
    cb(fakeRes);
    return { on() { return this; } };
  };
  return () => { https.get = original; };
}

function mockHttpsGetError(message) {
  const original = https.get;
  https.get = (_url, _opts, _cb) => {
    return {
      on(event, fn) {
        if (event === 'error') process.nextTick(() => fn(new Error(message)));
        return this;
      },
    };
  };
  return () => { https.get = original; };
}

function captureHttpsGet(responseBody) {
  const original = https.get;
  let captured;
  https.get = (url, options, callback) => {
    captured = { url: String(url), options };
    const fakeRes = {
      statusCode: 200,
      on(event, fn) {
        if (event === 'data') fn(JSON.stringify(responseBody));
        if (event === 'end') fn();
        return this;
      },
    };
    callback(fakeRes);
    return { on() { return this; } };
  };
  return {
    call: () => captured,
    restore: () => { https.get = original; },
  };
}

// ── load service ─────────────────────────────────────────────────────────────

// Fresh require each time so the module-level state is clean.
function loadSvc() {
  const mod = path.resolve(__dirname, '../backend/src/services/currencyConversionService');
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

// ── fixture ───────────────────────────────────────────────────────────────────

const FIXTURE = require('./fixtures/coingecko-simple-price.json');

// ── contract tests ─────────────────────────────────────────────────────────

describe('CoinGecko response shape contract (#893)', () => {
  let svc;
  beforeEach(() => { svc = loadSvc(); });

  // ── 1. Fixture validates against the contract ───────────────────────────

  test('recorded fixture passes checkCoinGeckoResponseShape for USD', () => {
    const result = svc.checkCoinGeckoResponseShape(FIXTURE, 'usd');
    expect(result).toEqual({ ok: true });
  });

  // ── 2. Each structural deviation is detected ────────────────────────────

  test('detects missing stellar key', () => {
    const broken = { 'usd-coin': { usd: 1.0 } };
    const result = svc.checkCoinGeckoResponseShape(broken, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stellar/);
  });

  test('detects missing usd-coin key', () => {
    const broken = { stellar: { usd: 0.24 } };
    const result = svc.checkCoinGeckoResponseShape(broken, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/usd-coin/);
  });

  test('detects stellar rate that is a string instead of a number', () => {
    const broken = { stellar: { usd: '0.24' }, 'usd-coin': { usd: 1.0 } };
    const result = svc.checkCoinGeckoResponseShape(broken, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stellar\.usd/);
  });

  test('detects stellar rate of zero (not a valid price)', () => {
    const broken = { stellar: { usd: 0 }, 'usd-coin': { usd: 1.0 } };
    const result = svc.checkCoinGeckoResponseShape(broken, 'usd');
    expect(result.ok).toBe(false);
  });

  test('detects stellar rate that is undefined (currency missing from response)', () => {
    const broken = { stellar: {}, 'usd-coin': { usd: 1.0 } };
    const result = svc.checkCoinGeckoResponseShape(broken, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stellar\.usd/);
  });

  test('detects usd-coin rate that is null', () => {
    const broken = { stellar: { usd: 0.24 }, 'usd-coin': { usd: null } };
    const result = svc.checkCoinGeckoResponseShape(broken, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/usd-coin\.usd/);
  });

  test('detects non-object top-level response (e.g. rate-limit error page)', () => {
    const result = svc.checkCoinGeckoResponseShape('Too Many Requests', 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not an object/);
  });

  test('detects CoinGecko ID rename — stellar renamed to xlm', () => {
    const renamed = { xlm: { usd: 0.24 }, 'usd-coin': { usd: 1.0 } };
    const result = svc.checkCoinGeckoResponseShape(renamed, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stellar/);
  });

  test('detects CoinGecko ID rename — usd-coin renamed to usdc', () => {
    const renamed = { stellar: { usd: 0.24 }, usdc: { usd: 1.0 } };
    const result = svc.checkCoinGeckoResponseShape(renamed, 'usd');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/usd-coin/);
  });

  // ── 3. Parser (_fetchFromCoinGecko) round-trips against the fixture ─────

  test('_fetchRatesFromCoinGecko correctly parses the fixture response', async () => {
    const restore = mockHttpsGet(FIXTURE);
    try {
      const rates = await svc._fetchRatesFromCoinGecko('usd');
      expect(rates.XLM).toBe(FIXTURE.stellar.usd);
      expect(rates.USDC).toBe(FIXTURE['usd-coin'].usd);
    } finally {
      restore();
    }
  });

  test('_fetchRatesFromCoinGecko throws when fixture shape is broken', async () => {
    const broken = { stellar: { usd: 0 }, 'usd-coin': { usd: 1.0 } };
    const restore = mockHttpsGet(broken);
    try {
      await expect(svc._fetchRatesFromCoinGecko('usd')).rejects.toThrow(/no valid XLM rate/);
    } finally {
      restore();
    }
  });
});

describe('CoinGecko API plan contract (#2029)', () => {
  const originalKey = process.env.COINGECKO_API_KEY;
  const originalPlan = process.env.COINGECKO_API_PLAN;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.COINGECKO_API_KEY;
    else process.env.COINGECKO_API_KEY = originalKey;
    if (originalPlan === undefined) delete process.env.COINGECKO_API_PLAN;
    else process.env.COINGECKO_API_PLAN = originalPlan;
  });

  test.each([
    ['demo', 'api.coingecko.com', 'x-cg-demo-api-key'],
    ['pro', 'pro-api.coingecko.com', 'x-cg-pro-api-key'],
  ])('uses the %s host and header without leaking the key in the URL', async (plan, host, header) => {
    process.env.COINGECKO_API_KEY = 'secret-test-key';
    process.env.COINGECKO_API_PLAN = plan;
    const capture = captureHttpsGet(FIXTURE);
    try {
      await loadSvc()._fetchRatesFromCoinGecko('usd');
      const request = capture.call();
      expect(new URL(request.url).host).toBe(host);
      expect(request.url).not.toContain('secret-test-key');
      expect(request.url).not.toMatch(/api_key/i);
      expect(request.options.headers).toEqual({ [header]: 'secret-test-key' });
    } finally {
      capture.restore();
    }
  });
});

// ── canary tests ──────────────────────────────────────────────────────────────

describe('CoinGecko canary (#893)', () => {
  let svc;
  beforeEach(() => { svc = loadSvc(); });

  test('canary returns ok:true when live response matches contract', async () => {
    const restore = mockHttpsGet(FIXTURE);
    try {
      const result = await svc.runCoinGeckoCanary('usd');
      expect(result).toEqual({ ok: true });
    } finally {
      restore();
    }
  });

  test('canary returns ok:false with reason when top-level key is renamed', async () => {
    const drifted = { xlm: { usd: 0.24 }, 'usd-coin': { usd: 1.0 } };
    const restore = mockHttpsGet(drifted);
    try {
      const result = await svc.runCoinGeckoCanary('usd');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/stellar/);
    } finally {
      restore();
    }
  });

  test('canary returns ok:false when the rate for the currency is absent', async () => {
    // CoinGecko could drop a vs_currency from the response
    const drifted = { stellar: {}, 'usd-coin': {} };
    const restore = mockHttpsGet(drifted);
    try {
      const result = await svc.runCoinGeckoCanary('usd');
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  test('canary returns ok:false when the HTTP request fails', async () => {
    const restore = mockHttpsGetError('ENOTFOUND api.coingecko.com');
    try {
      const result = await svc.runCoinGeckoCanary('usd');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/ENOTFOUND/);
    } finally {
      restore();
    }
  });

  test('canary returns ok:false on HTTP 429 (rate-limited)', async () => {
    const restore = mockHttpsGet({ status: 'too_many_requests' }, 429);
    try {
      const result = await svc.runCoinGeckoCanary('usd');
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  test('canary never throws — always returns a result object', async () => {
    // Even if something completely unexpected happens the canary must not throw
    const restore = mockHttpsGetError('Unexpected network failure');
    try {
      const result = await svc.runCoinGeckoCanary('eur');
      expect(typeof result).toBe('object');
      expect(typeof result.ok).toBe('boolean');
    } finally {
      restore();
    }
  });
});
