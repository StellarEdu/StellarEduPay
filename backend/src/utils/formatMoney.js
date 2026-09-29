'use strict';

/**
 * formatMoney — backend money formatter for reminder emails and SMS.
 *
 * Issue #1589: reminder emails were showing bare numbers like "250" with no
 * unit, making it impossible to tell whether the amount is XLM, USDC, or any
 * other asset. This utility:
 *
 *   1. Formats amounts with the asset code   → "250.00 USDC"
 *   2. Uses locale-aware number formatting   → Intl.NumberFormat
 *   3. Optionally appends a fiat equivalent  → "≈ ₦390,000 NGN at today's rate"
 *
 * It mirrors the contract of frontend/src/utils/formatCurrency.js so that
 * email and UI amounts are rendered consistently.
 *
 * Usage:
 *   formatCryptoAmount(250, 'USDC', 'en')          // → "250.00 USDC"
 *   formatCryptoAmount(0.0000001, 'XLM', 'fr')     // → "0,0000001 XLM"
 *
 *   await formatWithFiatEquivalent(250, 'USDC', 'NGN', 'en')
 *     // → "250.00 USDC (≈ ₦390,000 NGN at today's rate)"
 *     // → "250.00 USDC" when rate is unavailable (never throws)
 */

const { convertToLocalCurrency, CURRENCY_DECIMALS } = require('../services/currencyConversionService');

// Crypto assets always display 2 decimal places in emails (consistent with
// how Stellar amounts are typically presented to end-users).
const CRYPTO_DECIMALS = 2;

/**
 * Format a crypto amount with its asset code.
 *
 * @param {number} amount    - Raw numeric amount (e.g. 250 or 125.5)
 * @param {string} assetCode - Asset code shown after the number, e.g. "XLM" or "USDC"
 * @param {string} locale    - BCP-47 locale for number formatting (e.g. "en", "fr").
 *                             Defaults to "en". Tok Pisin ("tpi") falls back to "en".
 * @returns {string}         e.g. "250.00 USDC"
 */
function formatCryptoAmount(amount, assetCode = 'XLM', locale = 'en') {
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount)) return `${amount} ${assetCode}`;

  // Tok Pisin is not a recognised BCP-47 locale supported by Intl; fall back.
  const intlLocale = locale === 'tpi' ? 'en' : locale;

  try {
    const formatted = new Intl.NumberFormat(intlLocale, {
      minimumFractionDigits: CRYPTO_DECIMALS,
      maximumFractionDigits: CRYPTO_DECIMALS,
    }).format(safeAmount);
    return `${formatted} ${assetCode}`;
  } catch {
    // If Intl rejects the locale (e.g. unsupported BCP-47 tag), use toFixed.
    return `${safeAmount.toFixed(CRYPTO_DECIMALS)} ${assetCode}`;
  }
}

/**
 * Format a fiat amount with its currency code using locale-aware formatting.
 *
 * @param {number} amount       - Fiat amount
 * @param {string} currency     - ISO 4217 currency code, e.g. "NGN"
 * @param {string} locale       - BCP-47 locale for number formatting
 * @returns {string}            e.g. "₦390,000 NGN"
 */
function formatFiatAmount(amount, currency = 'USD', locale = 'en') {
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount)) return `${amount} ${currency}`;

  const intlLocale = locale === 'tpi' ? 'en' : locale;
  const dp = CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;

  try {
    const formatted = new Intl.NumberFormat(intlLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(safeAmount);
    // Append the ISO code after the symbol for clarity in plain-text emails.
    return `${formatted} ${currency}`;
  } catch {
    return `${safeAmount.toFixed(dp)} ${currency}`;
  }
}

/**
 * Format a crypto amount and optionally append the fiat equivalent.
 * Never throws — rate fetch failures silently omit the fiat part.
 *
 * @param {number} amount          - Crypto amount
 * @param {string} assetCode       - "XLM" | "USDC"
 * @param {string|null} localCurrency - ISO 4217 fiat currency, e.g. "NGN". When
 *                                     null/empty the fiat equivalent is omitted.
 * @param {string} locale          - BCP-47 locale for number formatting
 * @returns {Promise<string>}      e.g. "250.00 USDC (≈ ₦390,000 NGN at today's rate)"
 */
async function formatWithFiatEquivalent(amount, assetCode = 'XLM', localCurrency = null, locale = 'en') {
  const cryptoPart = formatCryptoAmount(amount, assetCode, locale);

  if (!localCurrency) return cryptoPart;

  try {
    const conv = await convertToLocalCurrency(amount, assetCode, localCurrency);
    if (!conv.available || conv.localAmount === null) return cryptoPart;
    const fiatPart = formatFiatAmount(conv.localAmount, conv.currency, locale);
    return `${cryptoPart} (≈ ${fiatPart} at today's rate)`;
  } catch {
    // Rate unavailable — return the crypto-only string; never block email delivery.
    return cryptoPart;
  }
}

module.exports = { formatCryptoAmount, formatFiatAmount, formatWithFiatEquivalent };
