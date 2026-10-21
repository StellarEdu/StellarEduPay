const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Simple in-memory cache for exchange rates
const rateCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the current exchange rate for a given asset against USD.
 * Falls back to a static rate when the external API is unavailable.
 *
 * @param {string} asset - Asset code (e.g. 'XLM', 'USDC')
 * @returns {Promise<number>} Price of one unit of the asset in USD
 */
async function getAssetUsdRate(asset) {
  const normalized = (asset || 'XLM').toUpperCase();

  // Stablecoins are pegged to USD
  if (normalized === 'USDC' || normalized === 'USDT') {
    return 1;
  }

  const cached = rateCache.get(normalized);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.rate;
  }

  try {
    const response = await axios.get(`${config.EXCHANGE_RATE_API_URL}`, {
      params: { asset: normalized },
      timeout: 5000,
    });
    const rate = Number(response.data?.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid rate returned for ${normalized}`);
    }
    rateCache.set(normalized, { rate, timestamp: Date.now() });
    return rate;
  } catch (error) {
    logger.warn(`Failed to fetch ${normalized} rate, using fallback: ${error.message}`);
    const fallback = normalized === 'XLM' ? 0.1 : 1;
    return fallback;
  }
}

/**
 * Convert an amount of a given asset into the target local currency.
 *
 * @param {number} amount - Amount in the source asset
 * @param {string} asset - Source asset code (e.g. 'XLM', 'USDC')
 * @param {string} targetCurrency - Target fiat currency code (e.g. 'NGN')
 * @returns {Promise<{amount: number, currency: string, rate: number, asset: string}>}
 */
async function convertToLocalCurrency(amount, asset, targetCurrency) {
  const normalizedAsset = (asset || 'XLM').toUpperCase();
  const normalizedCurrency = (targetCurrency || 'USD').toUpperCase();

  const assetUsdRate = await getAssetUsdRate(normalizedAsset);
  const usdToTarget = await getUsdToCurrencyRate(normalizedCurrency);

  const converted = Number(amount) * assetUsdRate * usdToTarget;

  return {
    amount: Number(converted.toFixed(2)),
    currency: normalizedCurrency,
    rate: Number((assetUsdRate * usdToTarget).toFixed(6)),
    asset: normalizedAsset,
  };
}

/**
 * Fetch the USD -> target fiat currency rate.
 *
 * @param {string} currency - Target fiat currency code
 * @returns {Promise<number>}
 */
async function getUsdToCurrencyRate(currency) {
  const normalized = (currency || 'USD').toUpperCase();
  if (normalized === 'USD') {
    return 1;
  }

  const cacheKey = `USD:${normalized}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.rate;
  }

  try {
    const response = await axios.get(`${config.EXCHANGE_RATE_API_URL}`, {
      params: { base: 'USD', currency: normalized },
      timeout: 5000,
    });
    const rate = Number(response.data?.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid rate returned for USD->${normalized}`);
    }
    rateCache.set(cacheKey, { rate, timestamp: Date.now() });
    return rate;
  } catch (error) {
    logger.warn(`Failed to fetch USD->${normalized} rate, using fallback: ${error.message}`);
    return 1;
  }
}

module.exports = {
  getAssetUsdRate,
  getUsdToCurrencyRate,
  convertToLocalCurrency,
};
