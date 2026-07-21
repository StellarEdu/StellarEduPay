"use strict";

/**
 * currencyConversionService — converts XLM and USDC amounts to local currency.
 *
 * Design decisions (Issue #796):
 *   - Primary provider: CoinGecko (/simple/price).
 *   - Secondary provider: Coinbase Exchange (/exchange-rates) — used
 *     automatically when CoinGecko fails or returns invalid data.
 *   - Redis-backed shared cache (keyed by `currency:rates:<CURRENCY>`).
 *     Falls back to in-process LRU Map when Redis is unavailable, so each
 *     replica does not independently hammer the price feed.
 *   - All logging via logger.child('CurrencyConversion') — no console.warn.
 *   - Prometheus gauges: price_feed_available{provider} and
 *     price_feed_staleness_seconds{provider}.
 *   - Stale-while-revalidate: serve stale cache when both providers fail,
 *     up to PRICE_STALE_THRESHOLD_MS (default 1 hour).
 *
 * Fix #888:
 *   - In-process fallback cache is now a bounded LRU (CURRENCY_LRU_MAX_SIZE,
 *     default 50). Once full, the least-recently-used entry is evicted, so
 *     memory growth is capped regardless of how many distinct currencies are
 *     seen.
 *   - Supported fiat currencies are enforced via an allowlist
 *     (ALLOWED_FIAT_CURRENCIES env var, comma-separated). Requests for
 *     currencies outside the allowlist are rejected immediately without
 *     hitting the price feed or the cache.
 * Fix #892: decimal-safe multiplication via decimal.js; per-currency decimal
 *   precision honours ISO 4217 (e.g. JPY = 0 dp, KWD = 3 dp, USD = 2 dp).
 */

const https   = require("https");
const Decimal = require("decimal.js");
const client = require("prom-client");
const { getRedisClient, isRedisReady } = require("../config/redisClient");
const logger = require("../utils/logger").child("CurrencyConversion");

// ── Per-currency decimal precision (ISO 4217) ─────────────────────────────────
//
// Most currencies use 2 decimal places.  Exceptions are listed here so that
// amounts in zero-decimal currencies (JPY, KRW …) are never shown as "¥1.23"
// and amounts in 3-decimal currencies (KWD, BHD …) are not under-rounded.
//
// Source: ISO 4217 minor unit definitions.
//
// CoinGecko response contract (documented here for #893):
//   GET /api/v3/simple/price?ids=stellar,usd-coin&vs_currencies=<CURRENCY>
//   {
//     "stellar":   { "<lc_currency>": <number> },   // XLM rate
//     "usd-coin":  { "<lc_currency>": <number> }    // USDC rate
//   }
//   Both keys MUST be present and their values MUST be positive finite numbers.
const CURRENCY_DECIMALS = {
  // 0 decimal places
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  MGA: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimal places
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // default is 2 — not listed here
};

/**
 * Multiply `amount` by `rate` using decimal-safe arithmetic and round to the
 * correct number of decimal places for `currency`.
 *
 * Returns a plain JS number suitable for JSON serialisation. Uses
 * ROUND_HALF_UP to match the expectation of most financial displays.
 *
 * @param {number|string} amount
 * @param {number|string} rate
 * @param {string}        currency  - ISO 4217 code (e.g. "USD", "JPY")
 * @returns {number}
 */
function _decimalMultiply(amount, rate, currency) {
  const dp = CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
  return new Decimal(amount)
    .times(new Decimal(rate))
    .toDecimalPlaces(dp, Decimal.ROUND_HALF_UP)
    .toNumber();
}

// ── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS             = parseInt(process.env.PRICE_CACHE_TTL_MS        || "60000",  10);
const PRICE_STALE_THRESHOLD_MS = parseInt(process.env.PRICE_STALE_THRESHOLD_MS  || "3600000", 10);
const COINGECKO_API_KEY        = process.env.COINGECKO_API_KEY || null;

// Supported-currencies list cache (#889):
//   Periodically refreshed from CoinGecko /simple/supported_vs_currencies.
//   Falls back to a static allowlist when the network call fails.
const SUPPORTED_CURRENCIES_TTL_MS =
  parseInt(process.env.SUPPORTED_CURRENCIES_TTL_MS || "3600000", 10); // 1 hour

// Maximum number of distinct currencies to keep in the in-process LRU cache.
// When the limit is reached the least-recently-used entry is evicted.
const CURRENCY_LRU_MAX_SIZE = parseInt(process.env.CURRENCY_LRU_MAX_SIZE || "50", 10);

// Redis cache TTL in seconds (slightly longer than in-memory TTL to allow
// cross-replica stale-while-revalidate).
const REDIS_CACHE_TTL_S = Math.ceil(PRICE_STALE_THRESHOLD_MS / 1000);

// ── Currency allowlist ────────────────────────────────────────────────────────
//
// ALLOWED_FIAT_CURRENCIES can be set as a comma-separated env var to restrict
// which target currencies the service will accept.  When the env var is absent
// the service defaults to a curated set of widely-supported fiat currencies.
//
// Keeping an explicit allowlist serves two purposes:
//   1. Prevents cache pollution from arbitrary/typo currency codes.
//   2. Avoids CoinGecko/Coinbase calls that are guaranteed to fail for
//      unsupported or non-existent currency identifiers.

const _DEFAULT_ALLOWED_FIAT = new Set([
  "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "NZD",
  "SEK", "KRW", "SGD", "NOK", "MXN", "INR", "RUB", "ZAR", "BRL", "TRY",
  "TWD", "DKK", "PLN", "THB", "IDR", "HUF", "CZK", "ILS", "CLP", "PHP",
  "AED", "COP", "SAR", "MYR", "RON", "PGK", "NGN", "GHS", "KES", "UGX",
  "TZS", "ETB", "RWF", "XOF", "XAF", "MAD", "EGP", "PKR", "BDT", "VND",
  // 3-decimal (ISO 4217) currencies — kept in sync with CURRENCY_DECIMALS.
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

/**
 * Build the runtime allowlist from the ALLOWED_FIAT_CURRENCIES env var or
 * fall back to _DEFAULT_ALLOWED_FIAT.  Returns a Set<string> of uppercase
 * currency codes.
 */
function _buildAllowlist() {
  const raw = process.env.ALLOWED_FIAT_CURRENCIES;
  if (!raw || !raw.trim()) return _DEFAULT_ALLOWED_FIAT;
  const codes = raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (codes.length === 0) return _DEFAULT_ALLOWED_FIAT;
  return new Set(codes);
}

// Evaluated once at module load; tests may call _resetAllowlist() to rebuild
// after changing the env var.
let ALLOWED_FIAT_CURRENCIES = _buildAllowlist();

function _resetAllowlist() {
  ALLOWED_FIAT_CURRENCIES = _buildAllowlist();
}

/**
 * Returns true when `currency` (already uppercased) is in the allowlist.
 */
function _isCurrencyAllowed(currency) {
  return ALLOWED_FIAT_CURRENCIES.has(currency);
}

// ── Prometheus metrics ───────────────────────────────────────────────────────

let _metricsInitialized = false;
let priceFeedAvailable;
let priceFeedStaleness;
let priceFeedLastSuccessTimestamp;
let priceFeedStale;

function _initMetrics() {
  if (_metricsInitialized) return;
  try {
    // Attempt to use the shared registry if metrics/index already initialized it.
    const { registry } = require("../metrics/index");

    priceFeedAvailable = new client.Gauge({
      name: "price_feed_available",
      help: "1 if the price feed provider is available, 0 otherwise",
      labelNames: ["provider"],
      registers: [registry],
    });

    priceFeedStaleness = new client.Gauge({
      name: "price_feed_staleness_seconds",
      help: "Seconds since the last successful price fetch per provider",
      labelNames: ["provider"],
      registers: [registry],
    });

    // Unix timestamp (seconds) of the most recent successful fetch per provider.
    // A value of 0 means no successful fetch has occurred since the process started.
    // Use `time() - price_feed_last_success_timestamp` in PromQL to compute age.
    priceFeedLastSuccessTimestamp = new client.Gauge({
      name: "price_feed_last_success_timestamp",
      help: "Unix timestamp (seconds) of the last successful price feed fetch per provider",
      labelNames: ["provider"],
      registers: [registry],
    });

    // Binary staleness flag: 1 when ALL providers have been failing long enough
    // that the cached rate has exceeded PRICE_STALE_THRESHOLD_MS, 0 otherwise.
    // Alert on `price_feed_stale == 1` for prolonged outage visibility.
    priceFeedStale = new client.Gauge({
      name: "price_feed_stale",
      help: "1 when the price feed cache has exceeded the stale threshold and fiat display is degraded, 0 otherwise",
      labelNames: ["provider"],
      registers: [registry],
    });

    _metricsInitialized = true;
  } catch (_) {
    // metrics/index not loaded yet — will be initialized lazily on first use
  }
}

function _recordAvailable(provider, available) {
  _initMetrics();
  if (priceFeedAvailable) priceFeedAvailable.set({ provider }, available ? 1 : 0);
}

function _recordStaleness(provider, lastSuccessfulFetchMs) {
  _initMetrics();
  if (priceFeedStaleness && lastSuccessfulFetchMs) {
    priceFeedStaleness.set({ provider }, Math.floor((Date.now() - lastSuccessfulFetchMs) / 1000));
  }
}

// Record the Unix timestamp (seconds) of a successful fetch for `provider`.
function _recordLastSuccess(provider) {
  _initMetrics();
  if (priceFeedLastSuccessTimestamp) {
    priceFeedLastSuccessTimestamp.set({ provider }, Math.floor(Date.now() / 1000));
  }
}

// ── In-process LRU cache (fallback when Redis unavailable) ───────────────────
//
// LruMap is a minimal least-recently-used Map backed by the native Map whose
// insertion/access order we maintain explicitly:
//   - On get: delete then re-insert so the key moves to the "most recent" end.
//   - On set: same re-insert pattern, then evict the oldest entry when over cap.
//
// This gives O(1) get/set/evict with no external dependencies.
//
// Structure: LruMap<CURRENCY, { rates, fetchedAt (ms), lastSuccessfulFetch (ms) }>

class LruMap {
  constructor(maxSize) {
    this._max  = Math.max(1, maxSize);
    this._map  = new Map();
  }

  has(key) {
    return this._map.has(key);
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    // Move to most-recently-used position.
    const value = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    // Evict the oldest (first) entry when over capacity.
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      logger.debug("LRU local cache evicted", { evicted: oldest, size: this._map.size });
    }
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }

  /** Iterate over [key, value] pairs — for getCachedRates() compatibility. */
  [Symbol.iterator]() {
    return this._map[Symbol.iterator]();
  }
}

const _localCache = new LruMap(CURRENCY_LRU_MAX_SIZE);

// ── In-flight deduplication ──────────────────────────────────────────────────
const _inFlight = new Map();

// ── Supported currencies cache (#889) ────────────────────────────────────────
// CoinGecko's /simple/supported_vs_currencies endpoint returns the authoritative
// list of fiat/crypto codes accepted by the price API.  We cache this for
// SUPPORTED_CURRENCIES_TTL_MS and refresh lazily so that school create/update
// can validate localCurrency up-front rather than discovering the error at
// conversion time.

// Static fallback — covers the most common fiat codes so validation still
// works when the network is unavailable at startup.
const STATIC_FALLBACK_CURRENCIES = new Set([
  "usd","eur","gbp","jpy","aud","cad","chf","cny","hkd","nzd",
  "sek","krw","sgd","nok","mxn","inr","rub","zar","try","brl",
  "twd","dkk","pln","thb","idr","huf","czk","ils","clp","php",
  "aed","cop","sar","myr","ron","ngn","kes","ghs","ugx","tzs",
  "rwf","etb","xof","mad","egp","pkr","bdt","vnd","pgk",
]);

let _supportedCurrenciesCache = null; // Set<string> (lowercase) | null
let _supportedCurrenciesFetchedAt = 0;
let _supportedCurrenciesInFlight = null;

/**
 * Return the set of vs_currencies supported by CoinGecko.
 * Refreshed at most once per SUPPORTED_CURRENCIES_TTL_MS.
 * Falls back to STATIC_FALLBACK_CURRENCIES on network failure.
 *
 * @returns {Promise<Set<string>>}  lowercase currency codes
 */
async function getSupportedCurrencies() {
  const now = Date.now();
  // Return cached set when still fresh.
  if (_supportedCurrenciesCache && now - _supportedCurrenciesFetchedAt < SUPPORTED_CURRENCIES_TTL_MS) {
    return _supportedCurrenciesCache;
  }

  // Deduplicate concurrent callers.
  if (_supportedCurrenciesInFlight) {
    try { return await _supportedCurrenciesInFlight; } catch { /* fall through */ }
  }

  _supportedCurrenciesInFlight = (async () => {
    try {
      let url = "https://api.coingecko.com/api/v3/simple/supported_vs_currencies";
      if (COINGECKO_API_KEY) url += `?x_cg_pro_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;
      const data = await httpsGet(url);
      if (!Array.isArray(data) || data.length === 0) throw new Error("Empty supported_vs_currencies response");
      const currencies = new Set(data.map((c) => String(c).toLowerCase()));
      _supportedCurrenciesCache = currencies;
      _supportedCurrenciesFetchedAt = Date.now();
      logger.info("Supported vs_currencies list refreshed", { count: currencies.size });
      return currencies;
    } catch (err) {
      logger.warn("Could not fetch supported_vs_currencies from CoinGecko — using static fallback", {
        error: err.message,
      });
      // Return stale cache if available, otherwise static fallback.
      return _supportedCurrenciesCache || STATIC_FALLBACK_CURRENCIES;
    } finally {
      _supportedCurrenciesInFlight = null;
    }
  })();

  return _supportedCurrenciesInFlight;
}

/**
 * Validate that `currencyCode` is in CoinGecko's supported vs_currencies list.
 * Returns { valid: boolean, supported: Set<string> }.
 *
 * @param {string} currencyCode  — e.g. "USD", "ngn", "PGK"
 * @returns {Promise<{ valid: boolean, supported: Set<string> }>}
 */
async function isSupportedCurrency(currencyCode) {
  const supported = await getSupportedCurrencies();
  return { valid: supported.has(String(currencyCode).toLowerCase()), supported };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode} from price feed`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Invalid JSON from price feed")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Price feed request timed out")); });
    req.on("error", reject);
  });
}

// ── Provider: CoinGecko ───────────────────────────────────────────────────────

async function _fetchFromCoinGecko(currency) {
  let url =
    "https://api.coingecko.com/api/v3/simple/price" +
    `?ids=stellar%2Cusd-coin&vs_currencies=${encodeURIComponent(currency)}`;
  if (COINGECKO_API_KEY) url += `&x_cg_pro_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;

  const data = await httpsGet(url);
  const xlmRate  = data?.stellar?.["" + currency];
  const usdcRate = data?.["usd-coin"]?.["" + currency];

  if (typeof xlmRate !== "number" || xlmRate <= 0)
    throw new Error(`CoinGecko: no valid XLM rate for "${currency}"`);
  if (typeof usdcRate !== "number" || usdcRate <= 0)
    throw new Error(`CoinGecko: no valid USDC rate for "${currency}"`);

  return { XLM: xlmRate, USDC: usdcRate };
}

// ── Provider: Coinbase Exchange ───────────────────────────────────────────────
// Uses /exchange-rates?currency=XLM and /exchange-rates?currency=USDC.
// Coinbase returns fiat rates for any supported vs_currency.

async function _fetchFromCoinbase(currency) {
  const [xlmData, usdcData] = await Promise.all([
    httpsGet(`https://api.coinbase.com/v2/exchange-rates?currency=XLM`),
    httpsGet(`https://api.coinbase.com/v2/exchange-rates?currency=USDC`),
  ]);

  const xlmRate  = parseFloat(xlmData?.data?.rates?.[currency.toUpperCase()]);
  const usdcRate = parseFloat(usdcData?.data?.rates?.[currency.toUpperCase()]);

  if (!isFinite(xlmRate)  || xlmRate  <= 0) throw new Error(`Coinbase: no valid XLM rate for "${currency}"`);
  if (!isFinite(usdcRate) || usdcRate <= 0) throw new Error(`Coinbase: no valid USDC rate for "${currency}"`);

  return { XLM: xlmRate, USDC: usdcRate };
}

// ── Shared cache helpers (Redis + local fallback) ─────────────────────────────

const _REDIS_KEY = (c) => `currency:rates:${c}`;

async function _readCache(key) {
  if (isRedisReady()) {
    try {
      const raw = await getRedisClient().get(_REDIS_KEY(key));
      if (raw) return JSON.parse(raw);
    } catch (e) {
      logger.warn("Redis cache read failed, falling back to local", { error: e.message });
    }
  }
  return _localCache.get(key) || null;
}

async function _writeCache(key, entry) {
  if (isRedisReady()) {
    try {
      await getRedisClient().set(_REDIS_KEY(key), JSON.stringify(entry), "EX", REDIS_CACHE_TTL_S);
    } catch (e) {
      logger.warn("Redis cache write failed, storing locally", { error: e.message });
    }
  }
  _localCache.set(key, entry);
}

// ── Core fetch with provider failover ────────────────────────────────────────

async function _fetchRates(currency) {
  // Try CoinGecko first, fall back to Coinbase.
  const providers = [
    { name: "coingecko",  fetch: () => _fetchFromCoinGecko(currency)  },
    { name: "coinbase",   fetch: () => _fetchFromCoinbase(currency)   },
  ];

  for (const { name, fetch } of providers) {
    try {
      const rates = await fetch();
      const now = Date.now();
      _recordAvailable(name, true);
      _recordStaleness(name, now);
      _recordLastSuccess(name);
      logger.info("Price feed fetch succeeded", { provider: name, currency });
      return { rates, fetchedAt: now, lastSuccessfulFetch: now, provider: name };
    } catch (err) {
      _recordAvailable(name, false);
      logger.warn("Price feed provider failed", { provider: name, currency, error: err.message });
    }
  }

  throw new Error(`All price feed providers failed for currency "${currency}"`);
}

// ── getRates (cache + dedup + stale-while-revalidate) ────────────────────────

async function getRates(currency) {
  const key = currency.toUpperCase();

  // Reject unsupported currencies immediately — don't hit the price feed or
  // the cache for codes that will never succeed (fix #888 allowlist).
  if (!_isCurrencyAllowed(key)) {
    throw new Error(`Currency "${key}" is not in the supported fiat allowlist`);
  }

  // Return from cache if fresh.
  const cached = await _readCache(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Deduplicate concurrent requests.
  if (_inFlight.has(key)) {
    try { return await _inFlight.get(key); }
    catch { _inFlight.delete(key); }
  }

  const fetchPromise = (async () => {
    try {
      const entry = await _fetchRates(key.toLowerCase());
      await _writeCache(key, entry);
      _inFlight.delete(key);
      return entry;
    } catch (err) {
      _inFlight.delete(key);
      // Stale-while-revalidate: return stale data within threshold.
      if (cached) {
        const staleAge = Math.floor((Date.now() - cached.lastSuccessfulFetch) / 1000);
        if (Date.now() - cached.lastSuccessfulFetch < PRICE_STALE_THRESHOLD_MS) {
          logger.warn("Serving stale rate", { currency: key, staleAge, provider: cached.provider });
          return { ...cached, stale: true, staleAge };
        }
        // Cache exists but the stale threshold is exhausted — flag the feed as stale.
        _recordStale(cached.provider);
      } else {
        // No cache at all — mark both providers as stale so the alert fires.
        _recordStale("coingecko");
        _recordStale("coinbase");
      }
      throw err;
    }
  })();

  _inFlight.set(key, fetchPromise);
  try { return await fetchPromise; }
  catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function convertToLocalCurrency(amount, assetCode = "XLM", targetCurrency = "USD") {
  const currency  = targetCurrency.toUpperCase();

  // Fast-path: reject unsupported currencies without touching the cache or feed.
  if (!_isCurrencyAllowed(currency)) {
    logger.warn("Currency not in allowlist", { currency });
    return { localAmount: null, currency, rate: null, rateTimestamp: null, available: false, stale: false, staleAge: null, unsupportedCurrency: true };
  }

  const rateEntry = await getRates(currency);

  if (!rateEntry) {
    return { localAmount: null, currency, rate: null, rateTimestamp: null, available: false, stale: false, staleAge: null };
  }

  const assetKey = assetCode === "USDC" ? "USDC" : "XLM";
  const rate = rateEntry.rates[assetKey];

  if (typeof rate !== "number" || rate <= 0) {
    return { localAmount: null, currency, rate: null, rateTimestamp: new Date(rateEntry.fetchedAt).toISOString(), available: false, stale: rateEntry.stale || false, staleAge: rateEntry.staleAge || null };
  }

  return {
    localAmount:   _decimalMultiply(amount, rate, currency),
    currency,
    rate,
    rateTimestamp: new Date(rateEntry.fetchedAt).toISOString(),
    available:     true,
    stale:         rateEntry.stale || false,
    staleAge:      rateEntry.staleAge || null,
  };
}

async function enrichPaymentWithConversion(payment, targetCurrency = "USD") {
  const assetCode  = payment.assetCode || "XLM";
  const conversion = await convertToLocalCurrency(payment.amount, assetCode, targetCurrency);

  const txHash     = payment.transactionHash || payment.txHash || null;
  const network    = process.env.STELLAR_NETWORK === "mainnet" ? "public" : "testnet";
  const explorerUrl = txHash ? `https://stellar.expert/explorer/${network}/tx/${txHash}` : null;

  return {
    ...payment,
    stellarExplorerUrl: explorerUrl,
    explorerUrl,
    localCurrency: {
      amount:       conversion.localAmount,
      currency:     conversion.currency,
      rate:         conversion.rate,
      rateTimestamp: conversion.rateTimestamp,
      available:    conversion.available,
    },
  };
}

async function formatWithLocalEquivalent(amount, assetCode = "XLM", targetCurrency = "USD") {
  const base = `${parseFloat(amount).toFixed(7)} ${assetCode}`;
  const conv = await convertToLocalCurrency(amount, assetCode, targetCurrency);
  if (!conv.available || conv.localAmount === null) return `${base} (rate unavailable)`;
  const dp = CURRENCY_DECIMALS[conv.currency.toUpperCase()] ?? 2;
  return `${base} (≈ ${conv.localAmount.toFixed(dp)} ${conv.currency})`;
}

function getCachedRates() {
  const result = {};
  for (const [k, v] of _localCache) {
    result[k] = { rates: { ...v.rates }, fetchedAt: new Date(v.fetchedAt) };
  }
  return result;
}

function resetCache() {
  _localCache.clear();
  _inFlight.clear();
}

// Back-compat aliases
const fetchXlmRate       = (c = "usd") => getRates(c.toUpperCase()).then((e) => e?.rates?.XLM ?? null);
const convertXlmToLocal  = (a, c = "USD") => convertToLocalCurrency(a, "XLM", c);
const formatWithConversion = (a, c = "USD") => formatWithLocalEquivalent(a, "XLM", c);
const attachConversion   = (o, c = "USD") => enrichPaymentWithConversion(o, c);

/**
 * #883 — Capture a fiat snapshot at payment confirmation time.
 * Returns a plain object suitable for embedding in the payment document.
 * Never throws — returns null if the rate is unavailable so the payment
 * save is never blocked by a price-feed failure.
 *
 * @param {number} amount      - Crypto amount (XLM or USDC)
 * @param {string} assetCode   - 'XLM' | 'USDC'
 * @param {string} currency    - Target fiat currency code, e.g. 'USD'
 */
async function captureFiatSnapshot(amount, assetCode = "XLM", currency = "USD") {
  try {
    const result = await convertToLocalCurrency(amount, assetCode, currency);
    if (!result || !result.available || result.localAmount === null) return null;
    return {
      fiatAmount:    result.localAmount,
      fiatCurrency:  result.currency,
      fiatRate:      result.rate,
      rateSource:    null,       // provider name not exposed here; ok for snapshot
      rateTimestamp: result.rateTimestamp ? new Date(result.rateTimestamp) : new Date(),
    };
  } catch {
    return null;
  }
}

// ── CoinGecko response contract canary (#893) ─────────────────────────────────
//
// Validates that a CoinGecko /simple/price response for the given currency
// still conforms to the expected shape.  Returns { ok: true } when valid or
// { ok: false, reason: string } when the shape has changed.
//
// Intended use:
//   1. In periodic health checks / cron jobs to detect silent API drift.
//   2. In contract tests against a recorded fixture to prevent regressions.
//
// Expected shape (documented contract):
//   data.stellar[lc_currency]     — positive finite number  (XLM rate)
//   data['usd-coin'][lc_currency] — positive finite number  (USDC rate)
function checkCoinGeckoResponseShape(data, currency) {
  const lc = (currency || "").toLowerCase();

  if (!data || typeof data !== "object") {
    return { ok: false, reason: "response is not an object" };
  }
  if (!data.stellar || typeof data.stellar !== "object") {
    return { ok: false, reason: 'missing top-level key "stellar"' };
  }
  if (!data["usd-coin"] || typeof data["usd-coin"] !== "object") {
    return { ok: false, reason: 'missing top-level key "usd-coin"' };
  }

  const xlmRate  = data.stellar[lc];
  const usdcRate = data["usd-coin"][lc];

  if (typeof xlmRate !== "number" || !isFinite(xlmRate) || xlmRate <= 0) {
    return { ok: false, reason: `stellar.${lc} is not a positive finite number (got ${JSON.stringify(xlmRate)})` };
  }
  if (typeof usdcRate !== "number" || !isFinite(usdcRate) || usdcRate <= 0) {
    return { ok: false, reason: `usd-coin.${lc} is not a positive finite number (got ${JSON.stringify(usdcRate)})` };
  }

  return { ok: true };
}

/**
 * Periodic canary: fetches a live CoinGecko rate for `currency` (default
 * "usd") and validates the response shape.  Logs a warning when the shape
 * has drifted so operators are alerted before conversions silently fail.
 *
 * Never throws — designed to be called from a health check or cron without
 * disrupting the main application flow.
 *
 * @param {string} [currency="usd"]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function runCoinGeckoCanary(currency = "usd") {
  try {
    let url =
      "https://api.coingecko.com/api/v3/simple/price" +
      `?ids=stellar%2Cusd-coin&vs_currencies=${encodeURIComponent(currency)}`;
    if (COINGECKO_API_KEY) url += `&x_cg_pro_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;

    const data   = await httpsGet(url);
    const result = checkCoinGeckoResponseShape(data, currency);

    if (!result.ok) {
      _recordAvailable("coingecko", false);
      logger.warn("CoinGecko canary: response shape mismatch", { currency, reason: result.reason });
    } else {
      logger.info("CoinGecko canary: response shape OK", { currency });
    }

    return result;
  } catch (err) {
    logger.warn("CoinGecko canary: fetch failed", { currency, error: err.message });
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  convertToLocalCurrency,
  enrichPaymentWithConversion,
  formatWithLocalEquivalent,
  captureFiatSnapshot,
  getCachedRates,
  resetCache,
  fetchXlmRate,
  convertXlmToLocal,
  formatWithConversion,
  attachConversion,
  // #889 — currency validation
  getSupportedCurrencies,
  isSupportedCurrency,
  // #893 — CoinGecko contract validation
  checkCoinGeckoResponseShape,
  runCoinGeckoCanary,
  CURRENCY_DECIMALS,
  // Testing internals
  _fetchRatesFromCoinGecko: (c) => _fetchFromCoinGecko(c),
  _getRates: getRates,
  _getCache: getCachedRates,
  _resetAllowlist,
  _getAllowlist: () => ALLOWED_FIAT_CURRENCIES,
  _getLocalCacheSize: () => _localCache.size,
};
