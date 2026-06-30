"use strict";

/**
 * currencyConversionService — converts XLM and USDC amounts to local currency.
 *
 * Design decisions (Issue #796):
 *   - Primary provider: CoinGecko (/simple/price).
 *   - Secondary provider: Coinbase Exchange (/exchange-rates) — used
 *     automatically when CoinGecko fails or returns invalid data.
 *   - Redis-backed shared cache (keyed by `currency:rates:<CURRENCY>`).
 *     Falls back to in-process Map when Redis is unavailable, so each replica
 *     does not independently hammer the price feed.
 *   - All logging via logger.child('CurrencyConversion') — no console.warn.
 *   - Prometheus gauges: price_feed_available{provider} and
 *     price_feed_staleness_seconds{provider}.
 *   - Stale-while-revalidate: serve stale cache when both providers fail,
 *     up to PRICE_STALE_THRESHOLD_MS (default 1 hour).
 */

const https = require("https");
const client = require("prom-client");
const { getRedisClient, isRedisReady } = require("../config/redisClient");
const logger = require("../utils/logger").child("CurrencyConversion");

// ── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS             = parseInt(process.env.PRICE_CACHE_TTL_MS        || "60000",  10);
const PRICE_STALE_THRESHOLD_MS = parseInt(process.env.PRICE_STALE_THRESHOLD_MS  || "3600000", 10);
const COINGECKO_API_KEY        = process.env.COINGECKO_API_KEY || null;

// Supported-currencies list cache (#889):
//   Periodically refreshed from CoinGecko /simple/supported_vs_currencies.
//   Falls back to a static allowlist when the network call fails.
const SUPPORTED_CURRENCIES_TTL_MS =
  parseInt(process.env.SUPPORTED_CURRENCIES_TTL_MS || "3600000", 10); // 1 hour

// Redis cache TTL in seconds (slightly longer than in-memory TTL to allow
// cross-replica stale-while-revalidate).
const REDIS_CACHE_TTL_S = Math.ceil(PRICE_STALE_THRESHOLD_MS / 1000);

// ── Prometheus metrics ───────────────────────────────────────────────────────

let _metricsInitialized = false;
let priceFeedAvailable;
let priceFeedStaleness;

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

// ── In-process cache (fallback when Redis unavailable) ───────────────────────
// Structure: Map<CURRENCY, { rates, fetchedAt (ms), lastSuccessfulFetch (ms) }>

const _localCache = new Map();

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
    localAmount:   parseFloat((amount * rate).toFixed(2)),
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
  return `${base} (≈ ${conv.localAmount.toFixed(2)} ${conv.currency})`;
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
  // Testing internals
  _fetchRatesFromCoinGecko: (c) => _fetchFromCoinGecko(c),
  _getRates: getRates,
  _getCache: getCachedRates,
};
