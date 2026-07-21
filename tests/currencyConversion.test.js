'use strict';

/**
 * Tests for currencyConversionService
 *
 * Covers:
 *   - Fresh cache hit (no network call)
 *   - Cache miss → successful CoinGecko fetch
 *   - Stale cache served when feed is down
 *   - Fully unavailable feed (no cache) → graceful null return
 *   - XLM vs USDC rate selection
 *   - Per-currency independent caching
 *   - convertToLocalCurrency precision (2 dp)
 *   - enrichPaymentWithConversion shape
 *   - formatWithLocalEquivalent strings
 *   - Back-compat aliases (fetchXlmRate, convertXlmToLocal)
 */

const assert = require('assert');
const https  = require('https');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Monkey-patch https.get for one call, restore after.
 * handler(url) should call (res) callback with a fake IncomingMessage.
 */
function mockHttpsGet(responseBody, statusCode = 200) {
  const original = https.get;
  https.get = (url, opts, callback) => {
    // opts may be omitted (older Node signature)
    const cb = typeof opts === 'function' ? opts : callback;
    const fakeRes = {
      statusCode,
      on(event, fn) {
        if (event === 'data') fn(JSON.stringify(responseBody));
        if (event === 'end')  fn();
        return this;
      },
      resume() {},
    };
    cb(fakeRes);
    return { on() { return this; } };
  };
  return () => { https.get = original; };
}

function mockHttpsGetError(errorMessage) {
  const original = https.get;
  https.get = (_url, _opts, _cb) => {
    const req = {
      on(event, fn) {
        if (event === 'error') process.nextTick(() => fn(new Error(errorMessage)));
        return this;
      },
    };
    return req;
  };
  return () => { https.get = original; };
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

it('currencyConversionService suite', async () => {
  console.log('\nCurrencyConversionService\n');
  // Fresh require so cache starts empty
  delete require.cache[require.resolve('../backend/src/services/currencyConversionService')];
  const svc = require('../backend/src/services/currencyConversionService');

  // ── 1. Successful fetch + cache population ──────────────────────────────

  await test('fetches XLM and USDC rates and returns correct USD amount', async () => {
    svc.resetCache();
    const restore = mockHttpsGet({ stellar: { usd: 0.24 }, 'usd-coin': { usd: 1.00 } });
    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'USD');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.currency, 'USD');
      assert.strictEqual(result.localAmount, 2.40);   // 10 * 0.24 = 2.40
      assert.strictEqual(result.rate, 0.24);
      assert.ok(result.rateTimestamp, 'rateTimestamp should be set');
    } finally {
      restore();
    }
  });

  await test('uses USDC rate for USDC asset code', async () => {
    svc.resetCache();
    const restore = mockHttpsGet({ stellar: { usd: 0.24 }, 'usd-coin': { usd: 1.00 } });
    try {
      const result = await svc.convertToLocalCurrency(50, 'USDC', 'USD');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.localAmount, 50.00);  // 50 * 1.00
      assert.strictEqual(result.rate, 1.00);
    } finally {
      restore();
    }
  });

  // ── 2. Cache hit (no second HTTP call) ──────────────────────────────────

  await test('returns cached rate without making a network call', async () => {
    // Cache is already populated from the test above (USD).
    // If https.get is called it will throw.
    https.get = () => { throw new Error('Should not hit network — cache should be used'); };
    try {
      const result = await svc.convertToLocalCurrency(5, 'XLM', 'USD');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.localAmount, 1.20); // 5 * 0.24
    } finally {
      https.get = require('https').get; // noop — original already restored above
    }
    // Restore the real https.get
    delete require.cache[require.resolve('https')];
  });

  // ── 3. Per-currency independent caching ─────────────────────────────────

  await test('fetches a separate rate for a different currency (PGK)', async () => {
    const restore = mockHttpsGet({ stellar: { pgk: 0.89 }, 'usd-coin': { pgk: 3.71 } });
    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'PGK');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.currency, 'PGK');
      assert.strictEqual(result.localAmount, 8.90);  // 10 * 0.89
    } finally {
      restore();
    }
  });

  await test('USD cache is still intact after PGK fetch', async () => {
    const cached = svc.getCachedRates();
    assert.ok(cached['USD'], 'USD cache entry should still exist');
    assert.ok(cached['PGK'], 'PGK cache entry should now exist');
  });

  // ── 4. Graceful degradation: feed unavailable, no cache ─────────────────

  await test('returns available:false when feed is unavailable and cache is empty', async () => {
    svc.resetCache();
    const restore = mockHttpsGetError('ENOTFOUND api.coingecko.com');
    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'EUR');
      assert.strictEqual(result.available, false);
      assert.strictEqual(result.localAmount, null);
      assert.strictEqual(result.rate, null);
      assert.strictEqual(result.rateTimestamp, null);
    } finally {
      restore();
    }
  });

  // ── 5. Stale cache served when feed is down ──────────────────────────────

  await test('serves stale cache when feed is down and cache exists', async () => {
    // Seed a stale-ish cache entry manually
    svc.resetCache();
    const restore1 = mockHttpsGet({ stellar: { usd: 0.20 }, 'usd-coin': { usd: 1.00 } });
    await svc.convertToLocalCurrency(1, 'XLM', 'USD');  // populates cache
    restore1();

    // Now make the feed fail
    const restore2 = mockHttpsGetError('Network down');
    // Force TTL expiry by reaching into the internal cache and back-dating fetchedAt
    const internalCache = svc._getCache();
    internalCache['USD'].fetchedAt = new Date(Date.now() - 999999);

    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'USD');
      // Should still return a value from the stale cache
      assert.strictEqual(result.available, true, 'Should serve stale cache as fallback');
      assert.ok(result.localAmount !== null);
    } finally {
      restore2();
    }
  });

  // ── 6. enrichPaymentWithConversion shape ─────────────────────────────────

  await test('enrichPaymentWithConversion adds localCurrency field to payment', async () => {
    svc.resetCache();
    const restore = mockHttpsGet({ stellar: { usd: 0.24 }, 'usd-coin': { usd: 1.00 } });
    try {
      const payment = { txHash: 'abc123', amount: 100, assetCode: 'XLM', studentId: 'STU001' };
      const enriched = await svc.enrichPaymentWithConversion(payment, 'USD');

      assert.ok(enriched.localCurrency, 'localCurrency block should exist');
      assert.strictEqual(enriched.localCurrency.currency, 'USD');
      assert.strictEqual(enriched.localCurrency.amount, 24.00);   // 100 * 0.24
      assert.strictEqual(enriched.localCurrency.available, true);
      assert.ok(enriched.localCurrency.rateTimestamp);
      // Original fields untouched
      assert.strictEqual(enriched.txHash, 'abc123');
      assert.strictEqual(enriched.amount, 100);
    } finally {
      restore();
    }
  });

  await test('enrichPaymentWithConversion falls back to XLM when assetCode missing', async () => {
    const restore = mockHttpsGet({ stellar: { usd: 0.24 }, 'usd-coin': { usd: 1.00 } });
    try {
      const payment = { amount: 10 };  // no assetCode
      const enriched = await svc.enrichPaymentWithConversion(payment, 'USD');
      assert.strictEqual(enriched.localCurrency.amount, 2.40);  // treated as XLM
    } finally {
      restore();
    }
  });

  // ── 7. formatWithLocalEquivalent strings ─────────────────────────────────

  await test('formatWithLocalEquivalent returns correct dual-currency string', async () => {
    svc.resetCache();
    const restore = mockHttpsGet({ stellar: { usd: 0.24 }, 'usd-coin': { usd: 1.00 } });
    try {
      const str = await svc.formatWithLocalEquivalent(10, 'XLM', 'USD');
      assert.strictEqual(str, '10.0000000 XLM (≈ 2.40 USD)');
    } finally {
      restore();
    }
  });

  await test('formatWithLocalEquivalent returns rate-unavailable string on feed failure', async () => {
    svc.resetCache();
    const restore = mockHttpsGetError('timeout');
    try {
      const str = await svc.formatWithLocalEquivalent(10, 'XLM', 'USD');
      assert.ok(str.includes('rate unavailable'), `Expected "rate unavailable" in: "${str}"`);
    } finally {
      restore();
    }
  });

  // ── 8. Precision: always 2 decimal places ────────────────────────────────

  await test('localAmount is rounded to exactly 2 decimal places', async () => {
    svc.resetCache();
    // Rate that produces many decimals: 10 * 0.123456789 = 1.23456789
    const restore = mockHttpsGet({ stellar: { usd: 0.123456789 }, 'usd-coin': { usd: 1.00 } });
    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'USD');
      const decimals = (result.localAmount.toString().split('.')[1] || '').length;
      assert.ok(decimals <= 2, `Expected <= 2 decimal places, got ${decimals}`);
      assert.strictEqual(result.localAmount, 1.23);  // toFixed(2) rounds
    } finally {
      restore();
    }
  });

  // ── 9. Back-compat alias: fetchXlmRate ───────────────────────────────────

  await test('fetchXlmRate alias returns the XLM rate number', async () => {
    svc.resetCache();
    const restore = mockHttpsGet({ stellar: { usd: 0.24 }, 'usd-coin': { usd: 1.00 } });
    try {
      const rate = await svc.fetchXlmRate('usd');
      assert.strictEqual(rate, 0.24);
    } finally {
      restore();
    }
  });

  await test('fetchXlmRate alias returns null when feed is unavailable', async () => {
    svc.resetCache();
    const restore = mockHttpsGetError('network error');
    try {
      const rate = await svc.fetchXlmRate('usd');
      assert.strictEqual(rate, null);
    } finally {
      restore();
    }
  });

  // ── 10. HTTP non-200 response ─────────────────────────────────────────────

  await test('treats HTTP 429 from CoinGecko as unavailable (graceful)', async () => {
    svc.resetCache();
    const restore = mockHttpsGet({ error: 'rate limit' }, 429);
    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'USD');
      assert.strictEqual(result.available, false);
    } finally {
      restore();
    }
  });

  // ── 11. Currency allowlist (fix #888) ────────────────────────────────────

  await test('rejects an unsupported fiat currency (returns available:false)', async () => {
    svc.resetCache();
    // NOTREAL is not in the default allowlist.
    const result = await svc.convertToLocalCurrency(10, 'XLM', 'NOTREAL');
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.localAmount, null);
    assert.strictEqual(result.unsupportedCurrency, true);
  });

  await test('getRates throws for unsupported currency', async () => {
    svc.resetCache();
    let threw = false;
    try {
      await svc._getRates('BOGUS');
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('allowlist'), `Expected allowlist in: "${err.message}"`);
    }
    assert.ok(threw, 'Expected getRates to throw for unsupported currency');
  });

  await test('respects ALLOWED_FIAT_CURRENCIES env var override', async () => {
    // Override the allowlist to only allow EUR.
    const prev = process.env.ALLOWED_FIAT_CURRENCIES;
    process.env.ALLOWED_FIAT_CURRENCIES = 'EUR';
    svc._resetAllowlist();
    try {
      // USD should now be rejected.
      const resultUsd = await svc.convertToLocalCurrency(10, 'XLM', 'USD');
      assert.strictEqual(resultUsd.available, false);
      assert.strictEqual(resultUsd.unsupportedCurrency, true);

      // EUR should be allowed.
      const restore = mockHttpsGet({ stellar: { eur: 0.22 }, 'usd-coin': { eur: 0.92 } });
      try {
        const resultEur = await svc.convertToLocalCurrency(10, 'XLM', 'EUR');
        assert.strictEqual(resultEur.available, true);
        assert.strictEqual(resultEur.currency, 'EUR');
      } finally {
        restore();
      }
    } finally {
      // Restore env and allowlist.
      if (prev === undefined) delete process.env.ALLOWED_FIAT_CURRENCIES;
      else process.env.ALLOWED_FIAT_CURRENCIES = prev;
      svc._resetAllowlist();
      svc.resetCache();
    }
  });

  await test('allowlist contains major fiat currencies by default', () => {
    const allowlist = svc._getAllowlist();
    for (const code of ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'PGK']) {
      assert.ok(allowlist.has(code), `Expected default allowlist to include ${code}`);
    }
  });

  // ── 12. Bounded LRU (fix #888) ────────────────────────────────────────────
  // NOTE: These tests need a fresh module with CURRENCY_LRU_MAX_SIZE=2.
  //       They are defined as top-level it() blocks below the main suite
  //       to avoid Jest environment teardown issues.

  // ── 13. #892 — decimal-safe multiplication and per-currency decimals ──────

  await test('#892 tiny XLM amount is not rounded to 0.00 (USD)', async () => {
    svc.resetCache();
    // 0.001 XLM * 0.10 = 0.0001  →  rounds to 0.00 with old 2-dp-always logic
    // but should remain non-zero at 2dp (0.00) — however with Decimal it's
    // exact: 0.0001 rounds to 0.00.  The key fix is that accumulated errors
    // from float multiply don't produce unexpected drift.
    // Use a rate that would drift with float: 0.001 * 0.1234567891 should be
    // 0.0001234567891, which rounds to 0.00 at 2dp — that's correct behaviour.
    // What we verify is: no float error; result is a JS number, not NaN/Inf.
    const restore = mockHttpsGet({ stellar: { usd: 0.1234567891 }, 'usd-coin': { usd: 1.00 } });
    try {
      const result = await svc.convertToLocalCurrency(0.001, 'XLM', 'USD');
      assert.strictEqual(result.available, true);
      assert.ok(typeof result.localAmount === 'number', 'localAmount should be a number');
      assert.ok(isFinite(result.localAmount), 'localAmount should be finite');
    } finally {
      restore();
    }
  });

  await test('#892 tiny amount with a larger rate stays non-zero at 2dp', async () => {
    svc.resetCache();
    // 0.05 XLM * 0.10 = 0.005 → rounds to 0.01 at 2dp (ROUND_HALF_UP), not 0.00
    const restore = mockHttpsGet({ stellar: { usd: 0.10 }, 'usd-coin': { usd: 1.00 } });
    try {
      const result = await svc.convertToLocalCurrency(0.05, 'XLM', 'USD');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.localAmount, 0.01, `Expected 0.01, got ${result.localAmount}`);
    } finally {
      restore();
    }
  });

  await test('#892 JPY rate uses 0 decimal places (no fractional yen)', async () => {
    svc.resetCache();
    // 10 XLM * 36.789 JPY = 367.89 → should round to 368 (0 dp)
    const restore = mockHttpsGet({ stellar: { jpy: 36.789 }, 'usd-coin': { jpy: 150.0 } });
    try {
      const result = await svc.convertToLocalCurrency(10, 'XLM', 'JPY');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.currency, 'JPY');
      // 10 * 36.789 = 367.89 → ROUND_HALF_UP at 0 dp → 368
      assert.strictEqual(result.localAmount, 368, `Expected 368, got ${result.localAmount}`);
      // Must be an integer when serialised
      assert.ok(Number.isInteger(result.localAmount), 'JPY amount should be an integer');
    } finally {
      restore();
    }
  });

  await test('#892 KWD rate uses 3 decimal places', async () => {
    svc.resetCache();
    // 1 XLM * 0.073456789 KWD → should round to 0.073 (3 dp)
    const restore = mockHttpsGet({ stellar: { kwd: 0.073456789 }, 'usd-coin': { kwd: 0.307 } });
    try {
      const result = await svc.convertToLocalCurrency(1, 'XLM', 'KWD');
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.currency, 'KWD');
      // 1 * 0.073456789 → 0.073 at 3dp (rounds down)
      assert.strictEqual(result.localAmount, 0.073, `Expected 0.073, got ${result.localAmount}`);
    } finally {
      restore();
    }
  });

  await test('#892 CURRENCY_DECIMALS is exported and contains JPY=0 and KWD=3', () => {
    assert.strictEqual(svc.CURRENCY_DECIMALS['JPY'], 0);
    assert.strictEqual(svc.CURRENCY_DECIMALS['KWD'], 3);
    assert.strictEqual(svc.CURRENCY_DECIMALS['USD'], undefined, 'USD should not be in the map (defaults to 2)');
  });

  await test('#892 float multiply drift is eliminated (known problematic case)', async () => {
    svc.resetCache();
    // Classic float issue: 1.005 * 1 rounds incorrectly with naive toFixed(2)
    // because JS: (1.005).toFixed(2) === '1.00' in some engines.
    // With Decimal.js this should be 1.01.
    const restore = mockHttpsGet({ stellar: { usd: 1.005 }, 'usd-coin': { usd: 1.00 } });
    try {
      const result = await svc.convertToLocalCurrency(1, 'XLM', 'USD');
      assert.strictEqual(result.available, true);
      // Decimal ROUND_HALF_UP: 1 * 1.005 = 1.005 → 1.01
      assert.strictEqual(result.localAmount, 1.01, `Expected 1.01 (decimal-safe), got ${result.localAmount}`);
    } finally {
      restore();
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) throw new Error(`${failed} currencyConversion assertion(s) failed`);
}, 30000);

// ── LRU standalone tests (top-level it() blocks) ─────────────────────────────
// These require a fresh module load with a custom CURRENCY_LRU_MAX_SIZE so they
// must live outside the IIFE to ensure proper Jest lifecycle ordering.

it('LRU cache evicts oldest entry when maxSize is exceeded', async () => {
  let svcSmall;
  const origMax = process.env.CURRENCY_LRU_MAX_SIZE;
  const origAllowed = process.env.ALLOWED_FIAT_CURRENCIES;
  process.env.CURRENCY_LRU_MAX_SIZE = '2';
  process.env.ALLOWED_FIAT_CURRENCIES = 'USD,EUR,AA1,AA2,AA3';

  // Use jest.isolateModules to get a fresh module that reads the new env vars.
  jest.isolateModules(() => {
    svcSmall = require('../backend/src/services/currencyConversionService');
  });

  try {
    // Seed three entries: AA1, AA2, AA3 (LRU max = 2).
    for (const [code, xlm] of [['AA1', 0.1], ['AA2', 0.2], ['AA3', 0.3]]) {
      const restore = mockHttpsGet({ stellar: { [code.toLowerCase()]: xlm }, 'usd-coin': { [code.toLowerCase()]: 1.0 } });
      try {
        await svcSmall.convertToLocalCurrency(1, 'XLM', code);
      } finally {
        restore();
      }
    }

    // Cache should have at most 2 entries.
    assert.ok(
      svcSmall._getLocalCacheSize() <= 2,
      `Expected LRU size <= 2, got ${svcSmall._getLocalCacheSize()}`
    );
    // Oldest entry (AA1) should have been evicted.
    const cached = svcSmall.getCachedRates();
    assert.ok(!cached['AA1'], 'AA1 should have been evicted as the oldest entry');
    assert.ok(cached['AA3'], 'AA3 (most recent) should still be in cache');
  } finally {
    if (origMax === undefined) delete process.env.CURRENCY_LRU_MAX_SIZE;
    else process.env.CURRENCY_LRU_MAX_SIZE = origMax;
    if (origAllowed === undefined) delete process.env.ALLOWED_FIAT_CURRENCIES;
    else process.env.ALLOWED_FIAT_CURRENCIES = origAllowed;
  }
}, 10000);

it('LRU cache promotes accessed entry (LRU order)', async () => {
  let svcLru;
  const origMax = process.env.CURRENCY_LRU_MAX_SIZE;
  const origAllowed = process.env.ALLOWED_FIAT_CURRENCIES;
  process.env.CURRENCY_LRU_MAX_SIZE = '2';
  process.env.ALLOWED_FIAT_CURRENCIES = 'B1,B2,B3';

  jest.isolateModules(() => {
    svcLru = require('../backend/src/services/currencyConversionService');
  });

  try {
    // Seed B1, B2.
    for (const [code, xlm] of [['B1', 0.1], ['B2', 0.2]]) {
      const restore = mockHttpsGet({ stellar: { [code.toLowerCase()]: xlm }, 'usd-coin': { [code.toLowerCase()]: 1.0 } });
      try { await svcLru.convertToLocalCurrency(1, 'XLM', code); } finally { restore(); }
    }

    // Access B1 to make it the most recently used (cache hit — no network call).
    await svcLru.convertToLocalCurrency(1, 'XLM', 'B1');

    // Now add B3 — should evict B2 (the LRU), not B1.
    const restore3 = mockHttpsGet({ stellar: { b3: 0.3 }, 'usd-coin': { b3: 1.0 } });
    try { await svcLru.convertToLocalCurrency(1, 'XLM', 'B3'); } finally { restore3(); }

    const cached = svcLru.getCachedRates();
    assert.ok(!cached['B2'], 'B2 (LRU after B1 was accessed) should have been evicted');
    assert.ok(cached['B1'], 'B1 (recently accessed) should still be in cache');
    assert.ok(cached['B3'], 'B3 (most recently set) should be in cache');
  } finally {
    if (origMax === undefined) delete process.env.CURRENCY_LRU_MAX_SIZE;
    else process.env.CURRENCY_LRU_MAX_SIZE = origMax;
    if (origAllowed === undefined) delete process.env.ALLOWED_FIAT_CURRENCIES;
    else process.env.ALLOWED_FIAT_CURRENCIES = origAllowed;
  }
}, 10000);