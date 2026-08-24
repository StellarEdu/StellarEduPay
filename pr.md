# Fix: `price_feed_stale` alert was unreachable — replace dead `_recordStale(...)` calls

Closes #1270

## Summary

The single code path that fires during a genuine, prolonged price-feed outage — **both** providers failing **and** the stale-while-revalidate window exhausted — called `_recordStale(...)`, a function that does not exist. The real helper is `_recordStaleness(provider, lastSuccessfulFetchMs)` (different name, different arity). All three call sites threw `ReferenceError: _recordStale is not defined`, the surrounding `catch { return null; }` swallowed it whole, and the `price_feed_stale` gauge was never set.

Result: the critical `PriceFeedStale` alert (`price_feed_stale == 1`, runbook, dashboard panel) was wired end to end in the monitoring stack and could never, under any circumstance, fire. The comment on the dead line — *"mark both providers as stale so the alert fires"* — stated intent the code never delivered.

This is a monitoring failure **and** an error-masking failure at once: the swallowed `ReferenceError` looked identical to a normal cache miss downstream, so nothing in the logs betrayed the defect.

## Changes

### Modified

| File | Description |
| ---- | ----------- |
| [`backend/src/services/currencyConversionService.js`](backend/src/services/currencyConversionService.js) | New `_markFeedStale(provider, stale)` / `_clearFeedStale()` helpers that set the authoritative gauge directly instead of deriving staleness from timestamps. Raised for **both** providers once both have failed past the window (or no cached rate exists) — that is exactly "fiat display degraded". **Self-healing**: any successful fetch clears the flag feed-wide via `_fetchRates`, since one working provider means conversions work again; per-provider `price_feed_staleness_seconds` keeps showing which provider lags. The cached-but-exhausted branch now also refreshes `_recordStaleness(cached.provider, cached.lastSuccessfulFetch)` so the age metric stays truthful. `getRates`' outer catch logs the failure at **error** level before returning null, so programming errors on this path are visible instead of masquerading as cache misses. Also fixes the pre-existing unused-`catch (_)` lint error — file is now fully ESLint-clean (the three `no-undef` errors are gone). |
| [`docs/runbooks/price-feed-staleness.md`](docs/runbooks/price-feed-staleness.md) | New **"Signal Hierarchy"** section reconciling the three overlapping signals: `price_feed_stale == 1` is **authoritative** for prolonged outages; `price_feed_staleness_seconds` is the continuous early-warning gradient (also rises while stale-but-valid cache is served); `price_feed_last_success_timestamp` is diagnosis/frozen-pipeline detection that resets on restarts. Includes implementation notes on feed-level raise/clear semantics and a historical note about this bug. |
| [`CHANGELOG.md`](CHANGELOG.md) | `[Unreleased]` entry under Fixed. |
| [`backend/src/routes/paymentRoutes.js`](backend/src/routes/paymentRoutes.js) | Companion one-line fix shared with the sibling PRs: removes the duplicate `requireSchoolAuth` import that breaks parsing of every suite loading `app.js`. Identical deletion across branches auto-resolves on *Update branch*. |

### Added

| File | Description |
| ---- | ----------- |
| [`tests/priceFeedStale.test.js`](tests/priceFeedStale.test.js) | 7 tests pinning the contract (deterministic timing via short `PRICE_CACHE_TTL_MS`/`PRICE_STALE_THRESHOLD_MS`, real prom-client registry reads): both-providers-down + no cache → gauge = 1 for both providers, `getRates` resolves null and never throws ReferenceError; swallowed failure logged at error level with the underlying provider error visible; cached-beyond-threshold → flag raised + staleness age refreshed from cached timestamp; within-threshold serving returns `stale:true` while keeping the critical flag **down** (warning-tier regime); recovery clears the flag to 0 feed-wide; graceful `convertToLocalCurrency` degradation. |

No new dependencies.

## Acceptance criteria mapping

| Criterion (from #1270) | Status |
|---|---|
| ESLint reports no `no-undef` in `currencyConversionService.js` | ✅ file is fully lint-clean |
| Unit test: both providers fail, no usable cache → gauge reads 1, no ReferenceError | ✅ `raises price_feed_stale=1 for both providers and never throws ReferenceError` |
| Second test for the cached-but-beyond-threshold branch | ✅ two tests cover it (flag + staleness refresh, error-content assertion) |
| The `catch { return null; }` logs the swallowed error | ✅ implemented + asserted (`the swallowed failure is logged at error level`) |
| Relationship between the three signals documented in the runbook | ✅ "Signal Hierarchy — Which Metric Is Authoritative?" section |

## Testing

- `tests/priceFeedStale.test.js`: 7/7 passing.
- Neighbouring suites green: `currencyConversion` (standalone behavioural suite), `coinGeckoContract`, `multi-asset-support`.
- Full `npm test` vs this branch's base: **zero new failing suites**; 34 previously-red suites pass again because of the companion import repair (they could not load `app.js` at base). Remaining failures reproduce identically on the base commit (mongodb-memory-server / SMTP-DNS environment flakes) and are untouched here.
- `cd backend && npx eslint src/services/currencyConversionService.js` → clean.

## Operational impact

- After deploy, `price_feed_stale{provider}` exists permanently (0 in healthy state), so the `PriceFeedStale` critical alert becomes reachable for the first time.
- During an outage the flag now follows the real lifecycle: warning tier (`staleness_seconds > 300`) while stale cache is served → critical tier (`price_feed_stale == 1`) once the window exhausts → back to 0 on first recovery.
- No API/schema changes; `getRates` still returns null when no rate is available (callers unaffected) — it just logs loudly now.
