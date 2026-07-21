# Payment Limits

## Overview

The Payment Limits feature provides configurable minimum and maximum thresholds for payment amounts as a security measure. This helps prevent:

- Accidental overpayments
- Fraudulent transactions
- System abuse
- Processing errors

## Configuration

Limits resolve at request time from the database, with the environment
variables as the final fallback. A deployment that never calls the admin API
behaves exactly as it did before this was introduced.

Resolution order, most specific first:

| # | Source | Scope |
| - | ------ | ----- |
| 1 | `School.settings.paymentLimits.assets[CODE]` | One school, one asset |
| 2 | `School.settings.paymentLimits.default` | One school |
| 3 | `SystemConfig` key `paymentLimits` → `assets[CODE]` | Global, one asset |
| 4 | `SystemConfig` key `paymentLimits` → `default` | Global |
| 5 | `MIN_PAYMENT_AMOUNT` / `MAX_PAYMENT_AMOUNT` | Env fallback |

Per-asset matters because XLM and USDC occupy very different value ranges — a
ceiling that is sensible for one is meaningless for the other. A deployment
accepts a single asset at a time today, so the asset key is largely
future-proofing, but storing limits without it would rebuild the same
conflation in the config model.

### Environment fallback

```bash
# Minimum payment amount (default: 0.01)
MIN_PAYMENT_AMOUNT=0.01

# Maximum payment amount (default: 100000)
MAX_PAYMENT_AMOUNT=100000

# How long resolved limits are cached in process (default: 30000)
PAYMENT_LIMITS_CACHE_TTL_MS=30000
```

### Validation Rules

Both the env values at boot and every admin write are checked against the same
rules:

1. `min` must be a finite, non-negative number
2. `max` must be a finite number greater than `min`
3. A bad env value prevents startup; a bad admin write is rejected with `400`
   and `INVALID_PAYMENT_LIMITS`

A stored value that somehow fails validation is ignored at resolution time and
the next layer down applies — a corrupt record degrades to a safe limit rather
than to no limit.

## Managing limits at runtime

Limits are a fraud-prevention control, so they need to be adjustable while an
incident is happening rather than on the next deploy.

```bash
# Read effective limits (add ?schoolId= to scope to a school)
GET /api/admin/payment-limits

# Set global limits
PUT /api/admin/payment-limits
{ "default": { "min": 1, "max": 5000 },
  "assets": { "USDC": { "min": 1, "max": 2000 } } }

# Set one school's limits
PUT /api/admin/payment-limits
{ "schoolId": "SCH001", "default": { "min": 2, "max": 800 } }

# Remove a school override, falling back to global
DELETE /api/admin/payment-limits/SCH001
```

All three require admin authentication. The `GET` response includes a `source`
field naming the layer that supplied the effective value — without it, a school
override silently masking a global change looks identical to the change not
having applied.

Every mutation is audit-logged at `high` severity with the before and after
values (`PAYMENT_LIMITS_UPDATED`, `PAYMENT_LIMITS_CLEARED`). Rejected writes are
logged too, as `PAYMENT_LIMITS_UPDATE_REJECTED` — a run of malformed writes
against a security control is itself worth seeing.

### Propagation

Resolved limits are cached in process for `PAYMENT_LIMITS_CACHE_TTL_MS`
(default 30s) because resolution sits in the payment hot path. A write
invalidates the cache immediately on the instance that served it; other
instances converge within the TTL. That bounded staleness is the trade for not
doing a database read per payment, and is still a different order of magnitude
from requiring a redeployment.

## Monitoring

`payment_limit_triggered_total{school_id,asset,code}` counts payments rejected
by the limits. Before it existed, the limits were a control with no feedback
loop — nothing told an operator the configured values had stopped matching real
payment behaviour.

Two alerts ship in `monitoring/alerts/payment_limits.yml`:

- **PaymentLimitTriggeredFrequently** (warning) — a sustained rejection rate for
  a school/asset/code. A sustained `AMOUNT_TOO_HIGH` is either a fee structure
  the ceiling no longer fits, or someone probing with large amounts.
- **PaymentLimitBlockingMostPayments** (critical) — more than half of received
  payments rejected, which in practice means a misconfiguration (a limit set in
  the wrong asset's value range does exactly this) and parents cannot pay.

## How It Works

### 1. Payment Verification

When a payment transaction is verified via the `/api/payments/verify` endpoint:

1. The transaction is fetched from the Stellar network
2. The payment amount is extracted and normalized
3. **Payment limit validation is performed**
4. If the amount is outside the configured limits, the transaction is rejected with an appropriate error code

### 2. Payment Intent Creation

When creating a payment intent via the `/api/payments/intent` endpoint:

1. The student's fee amount is retrieved
2. **The fee amount is validated against payment limits**
3. If the fee amount is outside limits, the intent creation is rejected

### 3. Payment Synchronization

During automatic payment synchronization:

1. Recent transactions are fetched from the Stellar network
2. Each payment amount is validated against limits
3. Payments outside limits are skipped and not recorded

## API Endpoints

### Get Payment Limits

Retrieve the current payment limit configuration.

**Endpoint**: `GET /api/payments/limits`

**Response**:
```json
{
  "min": 0.01,
  "max": 100000,
  "message": "Payment amounts must be between 0.01 and 100000"
}
```

### Get Payment Instructions (Updated)

The payment instructions endpoint now includes payment limits information.

**Endpoint**: `GET /api/payments/instructions/:studentId`

**Response**:
```json
{
  "walletAddress": "GXXX...",
  "memo": "STUDENT123",
  "acceptedAssets": [...],
  "paymentLimits": {
    "min": 0.01,
    "max": 100000
  },
  "note": "Include the payment intent memo exactly when sending payment to ensure your fees are credited."
}
```

## Error Codes

When a payment is rejected due to limit violations, the following error codes are returned:

| Code | Description | HTTP Status |
|------|-------------|-------------|
| `AMOUNT_TOO_LOW` | Payment amount is below the minimum allowed | 400 |
| `AMOUNT_TOO_HIGH` | Payment amount exceeds the maximum allowed | 400 |
| `INVALID_AMOUNT` | Payment amount is not a valid number or is zero/negative | 400 |

### Error Response Format

```json
{
  "error": "Payment amount 0.005 is below the minimum allowed amount of 0.01",
  "code": "AMOUNT_TOO_LOW"
}
```

## Implementation Details

### Validation Function

The core validation logic is implemented in [`backend/src/utils/paymentLimits.js`](../backend/src/utils/paymentLimits.js):

```javascript
function validatePaymentAmount(amount) {
  // Validates that amount is:
  // 1. A valid number
  // 2. Greater than zero
  // 3. Within configured min/max limits
  
  // Returns: { valid: boolean, error?: string, code?: string }
}
```

### Integration Points

Payment limit validation is integrated at three key points:

1. **[`stellarService.verifyTransaction()`](../backend/src/services/stellarService.js)** - Validates amounts during transaction verification
2. **[`paymentController.createPaymentIntent()`](../backend/src/controllers/paymentController.js)** - Validates fee amounts during intent creation
3. **[`stellarService.syncPayments()`](../backend/src/services/stellarService.js)** - Validates amounts during automatic synchronization

## Security Considerations

### Why Payment Limits Matter

1. **Fraud Prevention**: Limits help detect and prevent fraudulent transactions that may attempt to exploit the system
2. **Error Detection**: Catches accidental overpayments or data entry errors
3. **Resource Protection**: Prevents system abuse through extremely large or small transactions
4. **Compliance**: Helps meet regulatory requirements for transaction monitoring

### Best Practices

1. **Set Realistic Limits**: Configure limits based on your actual fee structure
2. **Monitor Rejections**: Track rejected payments to identify potential issues
3. **Regular Review**: Periodically review and adjust limits as needed
4. **Document Changes**: Keep a record of limit changes for audit purposes

## Testing

Comprehensive tests are available in [`tests/payment-limits.test.js`](../tests/payment-limits.test.js).

Run tests with:
```bash
npm test tests/payment-limits.test.js
```

### Test Coverage

- Valid amounts within limits
- Amounts below minimum
- Amounts above maximum
- Edge cases (zero, negative, NaN, non-numeric)
- Boundary values (exactly at min/max)

## Monitoring and Observability

### Rejected Payments

Payments rejected due to limit violations are recorded in the database with:
- Status: `failed`
- Student ID: `unknown` (if not identifiable)
- Amount: `0`

This provides an audit trail for security analysis.

### Metrics to Monitor

1. **Rejection Rate**: Track the percentage of payments rejected due to limits
2. **Rejection Reasons**: Monitor which limit (min/max) is triggered most often
3. **Temporal Patterns**: Identify if rejections cluster at certain times
4. **Student Impact**: Track if specific students are repeatedly affected

## Migration Guide

If you're adding payment limits to an existing deployment:

1. **Review Existing Data**: Analyze current payment amounts to set appropriate limits
2. **Set Conservative Limits**: Start with wider limits and tighten gradually
3. **Communicate Changes**: Notify users about the new limits
4. **Monitor Impact**: Watch for increased rejections after deployment
5. **Adjust as Needed**: Fine-tune limits based on real-world usage

## Troubleshooting

### Common Issues

**Issue**: Application won't start after adding payment limits
- **Cause**: Invalid configuration (e.g., max < min)
- **Solution**: Check `.env` file and ensure `MAX_PAYMENT_AMOUNT > MIN_PAYMENT_AMOUNT`

**Issue**: Valid payments are being rejected
- **Cause**: Limits set too restrictively
- **Solution**: Review and adjust `MIN_PAYMENT_AMOUNT` and `MAX_PAYMENT_AMOUNT`

**Issue**: Payment intent creation fails for existing students
- **Cause**: Student fee amounts exceed new limits
- **Solution**: Either adjust limits or update student fee amounts

## Future Enhancements

Potential improvements to the payment limits feature:

1. **Dynamic Limits**: Adjust limits based on student grade level or program
2. **Rate Limiting**: Limit number of payments per time period
3. **Admin UI**: A front-end for the limits API, which is currently HTTP-only
