'use strict';

/**
 * Tests for the price-feed prolonged-outage signal (#price_feed_stale).
 *
 * Background: the code path that fires when BOTH price providers have failed
 * AND the stale-while-revalidate window is exhausted used to call a
 * nonexistent `_recordStale(...)`. The resulting ReferenceError was swallowed
 * by `catch { return null; }`, so the `price_feed_stale` gauge was never set
 * and the critical PriceFeedStale alert could never fire — no matter how long
 * the outage lasted.
 *
 * These tests pin the contract:
 *   1. Both providers down + no usable cache  → gauge reads 1 for both
 *      providers, getRates resolves null (never throws ReferenceError), and
 *      the swallowed failure is logged at error level.
 *   2. Cached-but-beyond-threshold            → same flag behaviour, plus the
 *      per-provider staleness age is refreshed from the cached timestamp.
 *   3. Within-threshold stale serving         → stale data returned, flag
 *      stays down (that regime belongs to the warning-tier alerts).
 *   4. Recovery                               → any successful fetch clears
 *      the flag back to 0 for the whole feed.
 */

// Deterministic timing: tiny cache TTL / stale window (read at module load).
process.env.PRICE_CACHE_TTL_MS = "50";
process.env.PRICE_STALE_THRESHOLD_MS = "5000";

const mockLogSpies = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../backend/src/utils/logger", () => ({
  child: () => mockLogSpies,
}));

const https = require("https");
const { registry } = require("../backend/src/metrics/index");
const svc = require("../backend/src/services/currencyConversionService");

// ── https.get stubs ───────────────────────────────────────────────────────────

function mockHttpsFailure(errorMessage = "provider unreachable") {
  const original = https.get;
  https.get = (_url, _opts, _cb) => ({
    on(event, fn) {
      if (event === "error") process.nextTick(() => fn(new Error(errorMessage)));
      return this;
    },
  });
  return () => { https.get = original; };
}

function mockHttpsRates(body) {
  const original = https.get;
  https.get = (_url, opts, callback) => {
    const cb = typeof opts === "function" ? opts : callback;
    cb({
      statusCode: 200,
      on(event, fn) {
        if (event === "data") fn(JSON.stringify(body));
        if (event === "end") fn();
        return this;
      },
      resume() {},
    });
    return { on() { return this; } };
  };
  return () => { https.get = original; };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function staleGaugeValue(provider) {
  const metric = registry.getSingleMetric("price_feed_stale");
  if (!metric) return undefined;
  const { values } = await metric.get();
  const hit = values.find((v) => v.labels.provider === provider);
  return hit ? hit.value : undefined;
}

async function stalenessSeconds(provider) {
  const metric = registry.getSingleMetric("price_feed_staleness_seconds");
  if (!metric) return undefined;
  const { values } = await metric.get();
  const hit = values.find((v) => v.labels.provider === provider);
  return hit ? hit.value : undefined;
}

function seedCache(currency, ageMs) {
  svc._setLocalCacheEntry(currency, {
    rates: { XLM: 0.24, USDC: 1.0 },
    fetchedAt: Date.now() - ageMs,
    lastSuccessfulFetch: Date.now() - ageMs,
    provider: "coingecko",
  });
}

beforeEach(() => {
  svc.resetCache();
  // Isolate gauge state between tests (a Gauge holds series until reset).
  const g = registry.getSingleMetric("price_feed_stale");
  if (g) g.reset();
  jest.clearAllMocks();
});

// ── 1. Both providers down, no usable cache ──────────────────────────────────

describe("prolonged outage with no usable cache", () => {
  test("raises price_feed_stale=1 for both providers and never throws ReferenceError", async () => {
    const restore = mockHttpsFailure();

    try {
      // Must RESOLVE (null), not reject with ReferenceError.
      await expect(svc._getRates("USD")).resolves.toBeNull();

      expect(await staleGaugeValue("coingecko")).toBe(1);
      expect(await staleGaugeValue("coinbase")).toBe(1);
    } finally {
      restore();
    }
  });

  test("the swallowed failure is logged at error level", async () => {
    const restore = mockHttpsFailure();

    try {
      await svc._getRates("USD");

      expect(mockLogSpies.error).toHaveBeenCalled();
      const [msg, meta] = mockLogSpies.error.mock.calls[0];
      expect(msg).toMatch(/getRates failed/i);
      expect(meta).toMatchObject({ currency: "USD" });
      // The underlying provider failure must surface — not be lost.
      expect(JSON.stringify(meta)).toMatch(/price feed providers failed|coinbase|coingecko/i);
    } finally {
      restore();
    }
  });

  test("convertToLocalCurrency degrades gracefully to available:false", async () => {
    const restore = mockHttpsFailure();

    try {
      const result = await svc.convertToLocalCurrency(10, "XLM", "USD");
      expect(result).toMatchObject({ available: false, localAmount: null, rate: null });
    } finally {
      restore();
    }
  });
});

// ── 2. Cache exists but stale window exhausted ───────────────────────────────

describe("cache present but beyond the stale threshold", () => {
  test("raises the flag and refreshes the staleness age from the cached timestamp", async () => {
    seedCache("USD", 6000); // 6 s old — past the 5 s threshold, far past 50 ms TTL
    const restore = mockHttpsFailure();

    try {
      await expect(svc._getRates("USD")).resolves.toBeNull();

      expect(await staleGaugeValue("coingecko")).toBe(1);
      expect(await staleGaugeValue("coinbase")).toBe(1);

      // The cached provider's staleness age was refreshed from its timestamp…
      const age = await stalenessSeconds("coingecko");
      expect(age).toBeGreaterThanOrEqual(6);
      // …while the other provider has no successful fetch to measure from.
      expect(await stalenessSeconds("coinbase")).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("the underlying provider error is logged, not a ReferenceError", async () => {
    seedCache("USD", 6000);
    const restore = mockHttpsFailure();

    try {
      await svc._getRates("USD");

      const allErrorArgs = mockLogSpies.error.mock.calls
        .map(([msg, meta]) => `${msg} ${JSON.stringify(meta ?? "")}`)
        .join("\n");
      expect(allErrorArgs).not.toMatch(/_recordStale is not defined/);
      expect(allErrorArgs).toMatch(/All price feed providers failed/i);
    } finally {
      restore();
    }
  });
});

// ── 3. Within-threshold stale serving must NOT raise the critical flag ───────

describe("stale-but-within-threshold serving", () => {
  test("returns the stale rate and keeps price_feed_stale down", async () => {
    seedCache("USD", 1000); // 1 s old — past TTL, inside the 5 s threshold
    const restore = mockHttpsFailure();

    try {
      const entry = await svc._getRates("USD");

      expect(entry).toMatchObject({ stale: true, provider: "coingecko" });
      expect(entry.rates).toEqual({ XLM: 0.24, USDC: 1.0 });

      // Warning-tier condition only — the critical flag must stay unset.
      expect(await staleGaugeValue("coingecko")).toBeUndefined();
      expect(await staleGaugeValue("coinbase")).toBeUndefined();
    } finally {
      restore();
    }
  });
});

// ── 4. Recovery clears the flag ───────────────────────────────────────────────

describe("recovery", () => {
  test("any successful fetch clears price_feed_stale back to 0 for the whole feed", async () => {
    // Outage first: no cache, both providers failing.
    let restore = mockHttpsFailure();
    await svc._getRates("USD");
    expect(await staleGaugeValue("coingecko")).toBe(1);
    restore();

    // Feed recovers — CoinGecko serves again.
    restore = mockHttpsRates({ stellar: { usd: 0.25 }, "usd-coin": { usd: 1.0 } });
    try {
      svc.resetCache(); // force a fresh fetch past the 50 ms TTL
      const entry = await svc._getRates("USD");

      expect(entry.stale).toBeUndefined();
      expect(entry.provider).toBe("coingecko");

      // Whole-feed clearance: fiat display is healthy again even though the
      // other provider was never retried successfully here.
      expect(await staleGaugeValue("coingecko")).toBe(0);
      expect(await staleGaugeValue("coinbase")).toBe(0);
    } finally {
      restore();
    }
  });
});
