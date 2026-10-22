# Email Delivery

> Audit reference: Issue #80 (#869) — pluggable provider, retry, bounce/complaint
> handling, externalized templates.

All transactional email (payment receipts, fee reminders) flows through a single
module — `backend/src/services/email` — which provides a pluggable provider, a
retry path, and a suppression list. Individual services
(`emailService.js`, `notificationService.js`) only build content; they never talk
to a provider directly.

```
emailService.sendPaymentReceipt ─┐
                                 ├─> services/email.sendEmail() ─> provider.send()
notificationService.sendFeeReminder ─┘        │
                                              ├─ suppression check (skip if blocked)
                                              └─ retry w/ exponential backoff + jitter
```

## Providers

Selected via `EMAIL_PROVIDER` (`smtp` | `ses` | `sendgrid` | `console`). When
unset, the module auto-selects `smtp` if `SMTP_HOST/SMTP_USER/SMTP_PASS` are
configured, otherwise `console` (logs instead of sending — safe dev default).

Each provider implements `{ name, send(message), verify() }`
(`backend/src/services/email/providers/`). The AWS SES and SendGrid SDKs are
**optional** peer dependencies, required lazily — install only the one you use:

| Provider   | Required config                          | SDK package            |
|------------|------------------------------------------|------------------------|
| `console`  | —                                        | —                      |
| `smtp`     | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` | `nodemailer` (bundled) |
| `ses`      | `AWS_REGION` (+ standard AWS credentials) | `@aws-sdk/client-ses`  |
| `sendgrid` | `SENDGRID_API_KEY`                       | `@sendgrid/mail`       |

## Retry

`sendEmail()` retries transient send failures with exponential backoff + jitter.

| Env var               | Default | Meaning                         |
|-----------------------|---------|---------------------------------|
| `EMAIL_MAX_RETRIES`   | `3`     | Total attempts per send         |
| `EMAIL_RETRY_BASE_MS` | `500`   | Base backoff delay              |
| `EMAIL_RETRY_MAX_MS`  | `30000` | Backoff cap                     |

A genuine failure after all retries is surfaced to the caller. For reminders, a
failure throws so the reminder circuit breaker can trip; a *suppressed* recipient
is a deliberate skip, not a failure.

## Bounce & complaint suppression

The suppression list (`emailSuppressionModel`, `services/email/suppressionList.js`)
records addresses that must not be emailed again. `sendEmail()` consults it before
every send. A hard bounce or complaint also flips the matching student's
`reminderOptOut` (Issue #9 opt-out integration). Soft bounces are recorded for
visibility but do **not** block delivery.

### Provider webhooks

Providers report delivery events asynchronously. There is **one** endpoint per
provider (Issue #1641); each call both maintains the suppression list (bounces
and complaints) and updates email delivery status (`EmailDelivery`, the
student's `lastEmailDeliveryStatus`):

```
POST /api/email/webhooks/ses        (SES → SNS notifications)
POST /api/email/webhooks/sendgrid   (SendGrid Event Webhook)
POST /api/email/webhooks/generic    (pre-normalised events from any other provider)
```

These routes write to the suppression list (which permanently stops emails to
a parent), so they are authenticated per provider (Issue #1537) and protected
against replays (Issue #1641):

| Provider | Authentication | Replay protection | Configuration |
|----------|----------------|-------------------|---------------|
| `ses` | Amazon SNS message signature is verified (`SigningCertURL` must be on `sns.<region>.amazonaws.com`) and `TopicArn` must be allow-listed. `SubscriptionConfirmation` messages are confirmed automatically after verification. | SNS `MessageId` processed once | `EMAIL_SNS_TOPIC_ARNS` — comma-separated topic ARNs |
| `sendgrid` | SendGrid [Signed Event Webhook](https://docs.sendgrid.com/for-developers/tracking-events/getting-started-event-webhook-security-features) (ECDSA) signature, or — if no key is configured — the shared secret | Signed timestamp within `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`; each signature used once | `EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY` (preferred) or `EMAIL_WEBHOOK_SECRET` |
| `generic` | HMAC-SHA256 of the raw body in `X-StellarEduPay-Signature` (`sha256=<hex>`) | `X-StellarEduPay-Timestamp` within tolerance; `X-StellarEduPay-Delivery-ID` processed once | `EMAIL_PROVIDER_WEBHOOK_SECRET` (required in production — `503` otherwise) |

The `generic` body is one event or an array of events:
`{ "provider", "providerMessageId", "eventType": "delivered|opened|bounced|complaint|failed", "email", "schoolId", "studentId", "reason", "timestamp" }`.

- The shared secret `EMAIL_WEBHOOK_SECRET` is accepted **only** via the
  `X-Webhook-Token` header and compared in constant time. A `?token=` query
  parameter is rejected with `400` so secrets never appear in access or proxy
  logs.
- In **production**, unsigned or unauthenticated calls are always rejected. If
  none of `EMAIL_SNS_TOPIC_ARNS`, `EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY` or
  `EMAIL_WEBHOOK_SECRET` is set, the backend logs an error at startup and the
  ses/sendgrid routes answer `503 EMAIL_WEBHOOK_NOT_CONFIGURED`.
- Outside production with nothing configured, calls are accepted with a
  warning (local development only).
- Rejected calls are logged (never stored) and counted in the
  `email_webhook_rejections_total{provider, reason}` metric.

> **Deprecated:** `POST /api/email-provider-webhook/callback` is an alias of
> `/api/email/webhooks/generic` for one release. It logs a deprecation warning
> and responds with a `Deprecation` header. Repoint providers now.

#### Setting up Amazon SES (via SNS)

1. In SES, create a configuration set (or identity notification settings) that
   publishes **Bounce**, **Complaint** and **Delivery** events to an SNS topic.
2. Add the topic ARN to `EMAIL_SNS_TOPIC_ARNS`.
3. Create an HTTPS subscription on the topic to
   `https://<your-host>/api/email/webhooks/ses`. The subscription is confirmed
   automatically once its signature and topic are verified.

#### Setting up SendGrid

1. In *Settings → Mail Settings → Event Webhook*, set the HTTP POST URL to
   `https://<your-host>/api/email/webhooks/sendgrid`.
2. Select at least **Delivered**, **Opened**, **Bounced**, **Dropped** and
   **Spam Reports**.
3. Enable **Signed Event Webhook** and put the verification key in
   `EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY`.

### Operator endpoints (admin auth)

```
GET    /api/email/suppressions          list suppressed addresses
POST   /api/email/suppressions          manually suppress { email, reason, bounceType, detail }
DELETE /api/email/suppressions/:email   clear a suppression
```

## Templates

Bodies are externalized under `backend/src/templates/` and rendered by
`utils/templateRenderer.js` (`{{key}}` substitution and `{{#if key}}…{{/if}}`
blocks):

- `receiptEmail.txt` / `receiptEmail.html`
- `reminderEmail.txt` / `reminderEmail.html`
- `disputeNotification.txt` / `disputeNotification.html` — dispute confirmation,
  status updates and admin alerts (Issue #1638)

Rendering and the send path are covered by `backend/tests/emailService.test.js`.
