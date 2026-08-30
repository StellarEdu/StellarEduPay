# Webhook Notification System

StellarEduPay notifies external systems in real-time when payment events occur.

## Setup

### 1. Register a webhook URL

Register your HTTPS endpoint per school via the admin API:

```
POST /api/schools/:slug/webhooks
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "webhookUrl": "https://your-server.com/webhook"
}
```

Your school's HMAC signing secret is provisioned automatically when the school is created. Retrieve it from the admin dashboard to use in signature verification.

### 2. Receive events

Your endpoint receives `POST` requests with a JSON body:

```json
{
  "event": "payment.confirmed",
  "timestamp": "2026-03-27T10:30:00.000Z",
  "data": {
    "transactionHash": "abc123...",
    "studentId": "STU-001",
    "amount": 100.5,
    "assetCode": "XLM",
    "confirmedAt": "2026-03-27T10:30:00.000Z"
  }
}
```

## Events

| Event | Trigger |
|-------|---------|
| `payment.confirmed` | Payment verified and ledger-confirmed |
| `payment.pending` | Payment detected, awaiting confirmation |
| `payment.failed` | Payment failed on Stellar network |
| `payment.suspicious` | Flagged by fraud detection |

---

## Security: verifying the signature

Every delivery is signed with HMAC-SHA256 using your school's secret. Always verify the signature before processing the event.

### Headers sent on every delivery

| Header | Example | Purpose |
|--------|---------|---------|
| `X-StellarEduPay-Signature-V2` | `sha256=a1b2c3...` | **V2 HMAC-SHA256** covering timestamp, delivery-ID, and body (recommended) |
| `X-StellarEduPay-Signature` | `sha256=d4e5f6...` | V1 HMAC-SHA256 of the JSON body only (deprecated — use V2) |
| `X-StellarEduPay-Timestamp` | `1711532400` | Unix timestamp (seconds) of delivery |
| `X-StellarEduPay-Delivery-ID` | `550e8400-...` | Unique delivery UUID for idempotency |

---

## V2 Signature algorithm (recommended)

The V2 signature closes the replay-attack vector present in V1. It covers the
timestamp, the delivery-ID, **and** the exact body bytes in one signed string:

```
signing_base  = timestamp + "." + deliveryId + "." + rawBody
signature_v2  = HMAC-SHA256(secret, signing_base)
header_value  = "sha256=" + hex(signature_v2)
```

Where:
- `timestamp` is the value in `X-StellarEduPay-Timestamp` (Unix seconds, as a string)
- `deliveryId` is the value in `X-StellarEduPay-Delivery-ID`
- `rawBody` is the **exact bytes** of the HTTP request body

Because the timestamp and delivery-ID are now bound to the signature, an attacker
who captures a delivery cannot replay it by rewriting either header — the
signature check will fail.

> **Important:** compute the V2 signing base from the raw request body bytes
> (the exact bytes received over the wire). Do **not** re-serialise a parsed JS
> object; key-ordering differences will break the signature.

### Verification recipe (Node.js) — V2

```js
const crypto = require('crypto');

const TOLERANCE_S = 300; // 5 minutes

function verifyWebhookV2(rawBody, headers, secret) {
  // 1. Parse and range-check the timestamp
  const ts = parseInt(headers['x-stellaredupay-timestamp'], 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) {
    return { valid: false, reason: 'timestamp out of tolerance' };
  }

  // 2. Extract the V2 signature
  const deliveryId = headers['x-stellaredupay-delivery-id'] || '';
  const [, provided] = (headers['x-stellaredupay-signature-v2'] || '').split('sha256=');
  if (!provided) return { valid: false, reason: 'missing V2 signature' };

  // 3. Recompute over timestamp.deliveryId.rawBody
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();
  const signingBase = `${ts}.${deliveryId}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(signingBase).digest('hex');

  // 4. Constant-time comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: 'signature length mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}
```

### Verification recipe (Python) — V2

```python
import hashlib
import hmac
import time

TOLERANCE_S = 300  # 5 minutes

def verify_webhook_v2(raw_body: bytes, headers: dict, secret: str) -> bool:
    # 1. Parse and range-check the timestamp
    try:
        ts = int(headers.get('x-stellaredupay-timestamp', '0'))
    except ValueError:
        return False
    if abs(time.time() - ts) > TOLERANCE_S:
        return False

    # 2. Extract the V2 signature
    delivery_id = headers.get('x-stellaredupay-delivery-id', '')
    sig_header = headers.get('x-stellaredupay-signature-v2', '')
    if not sig_header.startswith('sha256='):
        return False
    provided = sig_header.removeprefix('sha256=')

    # 3. Recompute over timestamp.deliveryId.rawBody
    body_str = raw_body.decode('utf-8') if isinstance(raw_body, bytes) else raw_body
    signing_base = f'{ts}.{delivery_id}.{body_str}'.encode('utf-8')
    expected = hmac.new(secret.encode('utf-8'), signing_base, hashlib.sha256).hexdigest()

    # 4. Constant-time comparison
    return hmac.compare_digest(expected, provided)
```

### Verification recipe (Java) — V2

```java
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

public class WebhookVerifier {

    private static final int TOLERANCE_S = 300; // 5 minutes

    public static boolean verifyV2(
            byte[] rawBody,
            String timestampHeader,
            String deliveryIdHeader,
            String signatureV2Header,
            String secret) throws Exception {

        // 1. Parse and range-check the timestamp
        long ts = Long.parseLong(timestampHeader);
        if (Math.abs(System.currentTimeMillis() / 1000L - ts) > TOLERANCE_S) {
            return false;
        }

        // 2. Extract the V2 signature
        if (!signatureV2Header.startsWith("sha256=")) return false;
        String provided = signatureV2Header.substring(7);

        // 3. Recompute over timestamp.deliveryId.rawBody
        String bodyStr = new String(rawBody, StandardCharsets.UTF_8);
        String signingBase = ts + "." + deliveryIdHeader + "." + bodyStr;

        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] expectedBytes = mac.doFinal(signingBase.getBytes(StandardCharsets.UTF_8));
        String expected = HexFormat.of().formatHex(expectedBytes);

        // 4. Constant-time comparison
        byte[] expectedBuf = expected.getBytes(StandardCharsets.UTF_8);
        byte[] providedBuf = provided.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expectedBuf, providedBuf);
    }
}
```

---

## V1 Signature algorithm (deprecated)

> **V1 is deprecated.** It signs only the JSON body, leaving the timestamp and
> delivery-ID unsigned. An attacker who captures one delivery can replay it with
> a rewritten `X-StellarEduPay-Timestamp` header, bypassing the tolerance check.
> Migrate to V2 before the V1 removal date (see [Migration guide](#migration-guide-v1--v2) below).

The V1 signature is included on every delivery during the transition window so
existing integrators are not immediately broken. It will be removed in a future
release.

```
signature_v1 = HMAC-SHA256(secret, JSON.stringify(body))
header_value = "sha256=" + hex(signature_v1)
```

---

## Migration guide: V1 → V2

The V2 header (`X-StellarEduPay-Signature-V2`) is present on all deliveries
**now**. V1 (`X-StellarEduPay-Signature`) will continue to be sent in parallel
during the migration window to give you time to update your receiver.

**Migration steps:**

1. Update your signature-verification code to use `X-StellarEduPay-Signature-V2`
   with the new signing base `timestamp.deliveryId.rawBody` (examples above).
2. Ensure you read the raw request body bytes before parsing — many frameworks
   expose a `rawBody` buffer or middleware option (e.g. `express.raw()` or
   `bodyParser` with a `verify` hook).
3. Deploy and verify that your receiver accepts V2-signed deliveries in
   staging/pre-production.
4. Remove your V1 verification path.

**V1 removal date:** V1 signatures will be dropped after **2027-02-28**.
You will receive advance notice via the developer changelog and email.

> **Dual-signature transition period:** between now and the V1 removal date,
> every delivery carries both `X-StellarEduPay-Signature` (V1) and
> `X-StellarEduPay-Signature-V2`. Once you have migrated, verify only V2 and
> ignore V1.

---

## Replay protection

Use both the timestamp tolerance check **and** the delivery-ID as an idempotency
key. The V2 signature binds the timestamp and delivery-ID to the HMAC, so a
forged or rewritten header will fail the signature check. The delivery-ID
deduplication is a second, independent guard against exact replays.

```js
const processedIds = new Set(); // use Redis or a database for durability

app.post('/webhook', (req, res) => {
  const { valid, reason } = verifyWebhookV2(req.rawBody, req.headers, WEBHOOK_SECRET);
  if (!valid) {
    console.error('Webhook verification failed:', reason);
    return res.status(401).end();
  }

  const deliveryId = req.headers['x-stellaredupay-delivery-id'];
  if (processedIds.has(deliveryId)) {
    return res.status(200).json({ status: 'duplicate, ignored' });
  }
  processedIds.add(deliveryId);

  // … handle event …
  res.status(200).end();
});
```

> **Durability:** store delivery IDs in Redis or a database (not a process-local
> Set) so replay protection survives restarts and works across multiple replicas.

---

## Acknowledge quickly

Respond with **HTTP 2xx** within **10 seconds**. If your processing takes longer, acknowledge first and handle the event asynchronously.

## Retry logic

Failed deliveries are retried up to **3 times** with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1st retry | 1 minute |
| 2nd retry | 5 minutes |
| 3rd retry | 15 minutes |

After all retries are exhausted the delivery is moved to the dead-letter queue and is visible to administrators via `GET /api/admin/webhooks/dlq`. An admin can re-trigger a failed delivery with `POST /api/admin/webhooks/dlq/:id/retry`.

---

## Multiple endpoints and per-event subscriptions (#865)

Each school can register **multiple webhook endpoints**, each subscribing to a different set of events.

```
POST /api/webhook-endpoints
Authorization: Bearer <school-token>
X-School-ID: SCH-1
Content-Type: application/json

{
  "url": "https://your-server.com/payments",
  "subscribedEvents": ["payment.confirmed", "payment.failed"],
  "description": "ERP integration"
}
```

Response includes the `secret` (shown **once** at creation — store it securely).

### Manage endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/api/webhook-endpoints`        | Create endpoint |
| `GET`    | `/api/webhook-endpoints`        | List all endpoints for the school |
| `GET`    | `/api/webhook-endpoints/:id`    | Get single endpoint |
| `PUT`    | `/api/webhook-endpoints/:id`    | Update url / events / isActive |
| `DELETE` | `/api/webhook-endpoints/:id`    | Delete endpoint |

**Disabling an endpoint**: set `isActive: false` — it is silently skipped on all deliveries.

### Delivery history and replay

```
GET  /api/webhook-deliveries?endpointId=<id>&page=1&limit=20
POST /api/webhook-deliveries/:id/replay
```

Each delivery attempt is logged with status code, response body (truncated to 1 KB), duration, and error details.

---

## PII field controls (#867)

By default, webhook payloads are **minimal — no PII**. The fields `studentId` and `senderAddress` are excluded unless explicitly opted in.

### Default payload fields

```json
{
  "event": "payment.confirmed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "data": {
    "txHash": "abc123",
    "amount": 100,
    "assetCode": "XLM",
    "status": "confirmed",
    "schoolId": "SCH-1",
    "confirmedAt": "2026-01-01T00:00:00.000Z",
    "referenceCode": "REF-001"
  }
}
```

### Opt-in to PII fields

Update the school's `webhookPayloadConfig` via `PUT /api/schools/:id`:

```json
{
  "webhookPayloadConfig": {
    "allowedFields": [
      "event", "txHash", "amount", "assetCode", "status", "schoolId",
      "confirmedAt", "referenceCode", "studentId", "senderAddress"
    ]
  }
}
```

**Available fields**: `event`, `txHash`, `transactionHash`, `amount`, `asset`, `assetCode`, `status`, `schoolId`, `ts`, `timestamp`, `correlationId`, `referenceCode`, `finalFee`, `feeValidationStatus`, `confirmedAt`, `ledgerSequence`, `reason`, `isSuspicious`, `originalTxHash`, `refundTxHash`, `refundedAt`, `studentId` *(PII)*, `senderAddress` *(PII)*

---

## SSRF mitigations (#866)

All webhook URLs are validated at **registration time and again at every send**:

- Only `https://` scheme is accepted.
- Hostnames resolving to RFC 1918, loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10), CGNAT (100.64.0.0/10), and metadata ranges are blocked.
- IPv6 ULA (fc00::/7), IPv4-mapped private addresses (`::ffff:10.x.x.x`), and NAT64 prefixes are blocked.
- **Redirects are disabled** — a 3xx response from the endpoint is treated as a delivery failure (`SSRF_REDIRECT_BLOCKED`).
- Response bodies are capped at 64 KB.
- DNS is re-resolved immediately before each delivery (DNS-rebinding defence).

## Delivery history retention (#1414)

Every delivery attempt is recorded in the `webhookdeliveries` collection — one
document per attempt, per endpoint, per school. A busy deployment produces
these continuously, so the collection is bounded by a TTL index on `createdAt`
rather than kept forever.

**Default retention is 90 days.** After that MongoDB removes the record
automatically; the background TTL monitor runs about once a minute, so deletion
is prompt but not instant.

| Variable | Meaning | Default |
|---|---|---|
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | Retention in days | `90` |
| `WEBHOOK_DELIVERY_TTL_SECONDS` | Retention in seconds; **takes precedence** when set | — |

`WEBHOOK_DELIVERY_TTL_SECONDS` is kept for deployments that already configured
it, so upgrading does not silently change their retention. New deployments
should use `WEBHOOK_DELIVERY_RETENTION_DAYS`.

### What this means for you

- **Debugging window.** Delivery history for an endpoint is available for the
  retention period. Anything you need beyond that — compliance evidence, audit
  trails — must be exported to your own store before it expires.
- **Dead-letter counts.** The `webhook_dead_letter_total` metric counts failed
  deliveries that exhausted their retries. Expired records leave that count, so
  it reflects the retention window rather than all time.

### Applying it to an existing deployment

Mongoose only creates schema indexes on collections it creates, so a collection
that predates the TTL declaration will not have the index. Migration
`028_add_webhook_delivery_ttl_index` adds it, and re-creates it if the
configured retention has changed — MongoDB will not alter `expireAfterSeconds`
on an existing index in place.

```bash
npm run migrate
```

Verify:

```js
db.webhookdeliveries.getIndexes()
// { v: 2, key: { createdAt: 1 }, name: 'createdAt_1', expireAfterSeconds: 7776000 }
```
