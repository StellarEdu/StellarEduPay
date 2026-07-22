# Payment Verification Idempotency

## Overview

The payment verification endpoint (`POST /api/payments/verify`) now implements idempotency, allowing the same transaction hash to be verified multiple times without hitting the Stellar Horizon API repeatedly or returning errors.

## Problem Statement

Previously, calling the verify endpoint with the same `txHash` multiple times would:
- Return a `DUPLICATE_TX` error
- Require error handling on the client side
- Not provide access to the original verification result
- Create confusion for users retrying failed requests

## Solution

The endpoint now checks if a payment has already been verified and stored in the database. If found, it returns the cached result immediately without calling Horizon.

## Implementation

### Flow Diagram

```
POST /api/payments/verify { txHash: "abc123..." }
    ↓
Validate txHash format
    ↓
Check database for existing Payment
    ↓
    ├─ Found? → Return cached result (cached: true)
    │            - No Horizon API call
    │            - Instant response
    │            - Same data structure
    │
    └─ Not found? → Call Horizon API (cached: false)
                    - Verify transaction
                    - Store in database
                    - Return fresh result
```

### Code Changes

**Before:**
```javascript
const existing = await Payment.findOne({ txHash: normalizedHash });
if (existing) {
  const err = new Error("Transaction has already been processed");
  err.code = "DUPLICATE_TX";
  return next(err);
}
```

**After:**
```javascript
const existing = await Payment.findOne({ txHash: normalizedHash });
if (existing) {
  // Return cached result with all payment details
  return res.json({
    verified: true,
    cached: true,  // Indicates this is from cache
    hash: existing.txHash,
    memo: existing.memo,
    studentId: existing.studentId,
    amount: existing.amount,
    // ... all other fields
  });
}

// Fresh verification includes cached: false
res.json({
  verified: true,
  cached: false,  // Indicates fresh verification
  // ... all fields
});
```

## API Response

### Cached Response (Existing Payment)

```json
{
  "verified": true,
  "cached": true,
  "hash": "abc123...",
  "stellarExplorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123...",
  "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123...",
  "memo": "STU001",
  "studentId": "STU001",
  "amount": 100.5,
  "assetCode": "XLM",
  "assetType": "native",
  "feeAmount": 100,
  "feeValidation": {
    "status": "valid",
    "excessAmount": 0.5
  },
  "networkFee": null,
  "date": "2024-03-30T10:00:00.000Z",
  "status": "SUCCESS",
  "confirmationStatus": "confirmed",
  "localCurrency": {
    "amount": 1205.00,
    "currency": "USD",
    "rate": 12.0,
    "rateTimestamp": "2024-03-30T10:00:00.000Z",
    "available": true
  }
}
```

### Fresh Response (New Verification)

```json
{
  "verified": true,
  "cached": false,
  "hash": "def456...",
  "stellarExplorerUrl": "https://stellar.expert/explorer/testnet/tx/def456...",
  "explorerUrl": "https://stellar.expert/explorer/testnet/tx/def456...",
  "memo": "STU002",
  "studentId": "STU002",
  "amount": 200.0,
  "assetCode": "XLM",
  "assetType": "native",
  "feeAmount": 200,
  "feeValidation": {
    "status": "valid",
    "message": "Payment matches required fee",
    "excessAmount": 0
  },
  "networkFee": 0.00001,
  "date": "2024-03-30T11:00:00.000Z",
  "localCurrency": {
    "amount": 2400.00,
    "currency": "USD",
    "rate": 12.0,
    "rateTimestamp": "2024-03-30T11:00:00.000Z",
    "available": true
  }
}
```

## Benefits

### 1. Improved User Experience

- No errors when retrying verification
- Consistent response format
- Instant results for repeated requests

### 2. Reduced API Load

- Fewer calls to Stellar Horizon
- Lower latency for cached responses
- Better rate limit management

### 3. Network Resilience

- Safe to retry on network failures
- No duplicate processing concerns
- Idempotent by design

### 4. Client Simplification

**Before:**
```javascript
try {
  const result = await verifyPayment(txHash);
  displayResult(result);
} catch (error) {
  if (error.code === 'DUPLICATE_TX') {
    // Special handling needed
    showError('Already processed');
  } else {
    showError(error.message);
  }
}
```

**After:**
```javascript
// Simple retry logic
const result = await verifyPayment(txHash);
if (result.cached) {
  console.log('Retrieved from cache');
} else {
  console.log('Freshly verified');
}
displayResult(result);
```

## Use Cases

### 1. Network Retry

User's network fails during verification:
```javascript
// First attempt - network fails after Horizon call but before response
POST /api/payments/verify { txHash: "abc123" }
// → Network error, but payment was stored

// Retry - returns cached result instantly
POST /api/payments/verify { txHash: "abc123" }
// → { cached: true, ... }
```

### 2. Duplicate Submissions

User accidentally clicks "Verify" multiple times:
```javascript
// Click 1
POST /api/payments/verify { txHash: "abc123" }
// → { cached: false, ... } (fresh verification)

// Click 2 (immediate)
POST /api/payments/verify { txHash: "abc123" }
// → { cached: true, ... } (instant response)

// Click 3 (later)
POST /api/payments/verify { txHash: "abc123" }
// → { cached: true, ... } (still instant)
```

### 3. Status Checking

Frontend polls for payment status:
```javascript
// Check every 5 seconds
setInterval(async () => {
  const result = await verifyPayment(txHash);
  if (result.cached) {
    // No Horizon API calls, just database lookup
    updateUI(result);
  }
}, 5000);
```

## Performance Comparison

### Cached Response
- Database query: ~5-10ms
- Currency conversion: ~50-100ms
- Total: ~60-110ms

### Fresh Verification
- Horizon API call: ~200-500ms
- Database operations: ~10-20ms
- Currency conversion: ~50-100ms
- Total: ~260-620ms

**Improvement: 4-6x faster for cached responses**

## Testing

### Manual Testing

```bash
# First verification (fresh)
curl -X POST http://localhost:5000/api/payments/verify \
  -H "Content-Type: application/json" \
  -d '{"txHash":"abc123..."}'

# Response: { "cached": false, ... }

# Second verification (cached)
curl -X POST http://localhost:5000/api/payments/verify \
  -H "Content-Type: application/json" \
  -d '{"txHash":"abc123..."}'

# Response: { "cached": true, ... }
```

### Automated Testing

```javascript
describe('Payment Verification Idempotency', () => {
  test('first call returns cached: false', async () => {
    const response = await verifyPayment(newTxHash);
    expect(response.cached).toBe(false);
  });

  test('second call returns cached: true', async () => {
    await verifyPayment(existingTxHash);
    const response = await verifyPayment(existingTxHash);
    expect(response.cached).toBe(true);
  });

  test('cached response has same structure as fresh', async () => {
    const fresh = await verifyPayment(newTxHash);
    const cached = await verifyPayment(newTxHash);
    
    expect(cached).toMatchObject({
      verified: true,
      cached: true,
      hash: expect.any(String),
      amount: expect.any(Number),
      // ... all expected fields
    });
  });
});
```

## Monitoring

### Metrics to Track

1. **Cache Hit Rate**
   ```javascript
   const cacheHits = cachedResponses / totalRequests;
   // Target: > 30% for typical usage
   ```

2. **Response Time**
   ```javascript
   const avgCachedTime = sum(cachedResponseTimes) / cachedCount;
   const avgFreshTime = sum(freshResponseTimes) / freshCount;
   // Cached should be 4-6x faster
   ```

3. **Horizon API Calls**
   ```javascript
   const horizonCalls = freshVerifications;
   // Should decrease with idempotency
   ```

### Logging

The implementation logs cache hits:
```javascript
logger.info('Payment verification', {
  txHash: normalizedHash,
  cached: true,
  studentId: existing.studentId,
  amount: existing.amount
});
```

## Security Considerations

### 1. Data Consistency

Cached responses use stored data, which is immutable once in SUCCESS/FAILED state (enforced by Payment model pre-save hook).

### 2. Authorization

The endpoint still requires school context (`req.schoolId`), ensuring users can only verify payments for their school.

### 3. Data Freshness

Cached responses include original verification timestamps, allowing clients to determine data age.

## Cache Expiration & Currency Rate Freshness

`POST /api/payments/verify` is layered under two independent caches, each with its own freshness guarantee:

1. **Payment-record cache** (`Payment.findOne({ schoolId, txHash })`, `cached: true` in the
   response above). This is a permanent, business-level dedup: once a transaction has been
   verified on-chain it must never be re-verified, so this lookup intentionally has no TTL.
   However, the `localCurrency` block returned on this path is **never read from storage** — it
   is computed fresh on every call via `convertToLocalCurrency()`, so it always reflects a
   current (or very recently cached, see `PRICE_CACHE_TTL_MS`) exchange rate regardless of how
   old the underlying `Payment` record is.

2. **HTTP idempotency-key cache** (`backend/src/middleware/idempotency.js`, applied to this route
   via the `Idempotency-Key` header). This caches the *entire rendered response body* so that a
   client retry with the same key gets back byte-identical output. Records expire after
   `IDEMPOTENCY_KEY_TTL_SECONDS` (default `86400` = 24h; enforced by a MongoDB TTL index — see
   `backend/migrations/003_add_idempotency_key_ttl_index.js`), which is an appropriate window for
   replay/reuse protection but far too long to freeze a currency-conversion rate — a client
   replaying the same `Idempotency-Key` hours later should not see the exchange rate from the
   moment of the original call.

   To close that gap, the idempotency middleware **excludes `localCurrency` from the frozen
   snapshot**: whenever a cached response body contains a `localCurrency` object, the middleware
   recomputes it fresh (via `currencyConversionService.convertToLocalCurrency`, using the
   response's own `amount`/`assetCode`) on every replay, before the cached body is sent back. All
   other fields (hash, status, fee validation, etc.) are still served verbatim from cache. If the
   refresh call fails, the middleware falls back to the originally cached value rather than
   breaking the replay.

This means a cached idempotent response containing `localCurrency.rate` is never served with a
rate older than the currency-conversion service's own cache window
(`PRICE_CACHE_TTL_MS`, default 60s), independent of the 24h idempotency-record TTL.
See `backend/tests/idempotencyMiddlewareCurrencyFreshness.test.js` for coverage.

## Migration Notes

### Breaking Changes

None. The response structure is extended, not changed:
- Existing clients ignore the `cached` field
- New clients can use it for optimization

### Backward Compatibility

✅ Existing integrations continue to work
✅ Response structure unchanged (only added field)
✅ Error handling unchanged for new transactions

## Future Enhancements

1. **Cache Warming**
   - Pre-load recent transactions
   - Reduce first-request latency

2. **Analytics**
   - Track cache hit rates
   - Identify optimization opportunities

3. **Partial Updates**
   - Update confirmation status without full re-verification

> Cache expiration (TTL) and automatic currency-rate refresh, formerly listed
> here, are implemented — see "Cache Expiration & Currency Rate Freshness"
> above.

## Related Documentation

- `backend/src/controllers/paymentController.js` - Implementation
- `backend/src/models/paymentModel.js` - Payment schema
- `docs/api-spec.md` - API documentation
