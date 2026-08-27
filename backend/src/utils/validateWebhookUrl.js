'use strict';

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const { resolveDnsWithCache } = require('./dnsCache');

// ── Private / reserved IPv4 ranges ───────────────────────────────────────────
// Includes RFC 1918, loopback, link-local, CGNAT, metadata (AWS/GCP/Azure),
// benchmarking, and reserved ranges. Any resolved IP in these ranges is blocked.
const PRIVATE_IPv4_RANGES = [
  [0x00000000, 0x00FFFFFF], // 0.0.0.0/8        — "this" network
  [0x0A000000, 0x0AFFFFFF], // 10.0.0.0/8       — RFC 1918 Class A
  [0x64400000, 0x647FFFFF], // 100.64.0.0/10    — CGNAT (RFC 6598)
  [0x7F000000, 0x7FFFFFFF], // 127.0.0.0/8      — loopback
  [0xA9FE0000, 0xA9FEFFFF], // 169.254.0.0/16   — link-local / metadata
  [0xAC100000, 0xAC1FFFFF], // 172.16.0.0/12    — RFC 1918 Class B
  [0xC0000000, 0xC00000FF], // 192.0.0.0/24     — IETF protocol assignments
  [0xC0A80000, 0xC0A8FFFF], // 192.168.0.0/16   — RFC 1918 Class C
  [0xC6120000, 0xC613FFFF], // 198.18.0.0/15    — benchmarking (RFC 2544)
  [0xC6336400, 0xC63364FF], // 198.51.100.0/24  — TEST-NET-2 (RFC 5737)
  [0xCB007100, 0xCB0071FF], // 203.0.113.0/24   — TEST-NET-3 (RFC 5737)
  [0xE0000000, 0xEFFFFFFF], // 224.0.0.0/4      — multicast
  [0xF0000000, 0xFFFFFFFF], // 240.0.0.0/4      — reserved
];

/**
 * Convert a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToLong(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

/**
 * Return true if the IPv4 address falls in any private/reserved range.
 * @param {string} ip  Dotted-decimal IPv4 (e.g. "10.0.0.1")
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
  const n = ipv4ToLong(ip);
  return PRIVATE_IPv4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * Return true if the IPv6 address falls in any private/reserved range.
 *
 * Covered ranges:
 *   ::1              — loopback
 *   fc00::/7         — Unique Local Address (ULA, RFC 4193)
 *   fe80::/10        — link-local
 *   ::ffff:0:0/96    — IPv4-mapped; delegates to isPrivateIPv4
 *   64:ff9b::/96     — IPv4-translated (NAT64)
 *
 * @param {string} ip  Full IPv6 address string (may include brackets stripped by caller)
 * @returns {boolean}
 */
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (lower === '::1') return true;

  // IPv4-mapped: ::ffff:a.b.c.d — delegate to IPv4 check
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return isPrivateIPv4(mapped[1]);

  // IPv4-mapped hex form: ::ffff:c0a8:0101 (192.168.1.1)
  // Handled above by net.isIPv6 expansion in most Node versions,
  // but add a belt-and-suspenders prefix check.
  if (lower.startsWith('::ffff:')) return true;

  // Unique Local Address (fc00::/7): fc00–fdff prefixes
  if (/^f[cd]/i.test(lower)) return true;

  // Link-local: fe80::/10 — fe80 to febf
  if (/^fe[89ab]/i.test(lower)) return true;

  // Loopback-adjacent compressed forms: :: or ::0
  if (lower === '::' || lower === '::0') return true;

  // NAT64 prefix 64:ff9b::/96
  if (lower.startsWith('64:ff9b::')) return true;

  return false;
}

/**
 * Check a single resolved IP (v4 or v6) against the deny list.
 *
 * @param {string} ip
 * @returns {{ blocked: boolean, reason?: string }}
 */
function validateResolvedIp(ip) {
  if (net.isIPv4(ip)) {
    return isPrivateIPv4(ip)
      ? { blocked: true, reason: `Private/reserved IPv4 address: ${ip}` }
      : { blocked: false };
  }

  if (net.isIPv6(ip)) {
    return isPrivateIPv6(ip)
      ? { blocked: true, reason: `Private/reserved IPv6 address: ${ip}` }
      : { blocked: false };
  }

  // Not parseable as IP — should not happen after DNS resolution
  return { blocked: true, reason: `Unrecognised IP format: ${ip}` };
}

/**
 * Validate a webhook URL for SSRF safety.
 *
 * Rules:
 *   1. Must use the https: protocol.
 *   2. Hostname must not be a well-known internal name (localhost, *.local, …).
 *   3. IP literals are checked directly against the deny list.
 *   4. Hostnames are DNS-resolved; ALL returned addresses must be public.
 *      Resolved IPs are returned so the caller can pin them for send-time check.
 *
 * @param {string} url
 * @returns {Promise<{ valid: boolean, reason?: string, resolvedIps?: string[] }>}
 */
async function validateWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'INVALID_WEBHOOK_URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'INVALID_WEBHOOK_URL' };
  }

  const hostname = parsed.hostname;

  // ── Bare IPv4 literal ──────────────────────────────────────────────────────
  if (net.isIPv4(hostname)) {
    const check = validateResolvedIp(hostname);
    return check.blocked
      ? { valid: false, reason: 'INVALID_WEBHOOK_URL' }
      : { valid: true, resolvedIps: [hostname] };
  }

  // ── IPv6 literal (URL parser keeps brackets: [::1]) ───────────────────────
  const rawIPv6 = hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv6(rawIPv6)) {
    const check = validateResolvedIp(rawIPv6);
    return check.blocked
      ? { valid: false, reason: 'INVALID_WEBHOOK_URL' }
      : { valid: true, resolvedIps: [rawIPv6] };
  }

  // ── Well-known internal hostnames (no DNS round-trip needed) ──────────────
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.example') ||   // RFC 2606 reserved
    lower.endsWith('.test') ||      // RFC 2606 reserved
    lower.endsWith('.invalid')      // RFC 2606 reserved
  ) {
    return { valid: false, reason: 'INVALID_WEBHOOK_URL' };
  }

  // ── DNS resolution: all addresses must be public ───────────────────────────
  let allAddresses;
  try {
    allAddresses = await resolveDnsWithCache(hostname);
  } catch {
    return { valid: false, reason: 'INVALID_WEBHOOK_URL' };
  }

  for (const addr of allAddresses) {
    const check = validateResolvedIp(addr);
    if (check.blocked) {
      return { valid: false, reason: 'INVALID_WEBHOOK_URL' };
    }
  }

  return { valid: true, resolvedIps: allAddresses };
}

module.exports = {
  validateWebhookUrl,
  validateResolvedIp,
  isPrivateIPv4,
  isPrivateIPv6,
};
