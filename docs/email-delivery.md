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

Providers report bounces/complaints asynchronously. Point them at:

```
POST /api/email/webhooks/ses        (SES → SNS notifications)
POST /api/email/webhooks/sendgrid   (SendGrid Event Webhook)
```

Protect them with a shared secret: set `EMAIL_WEBHOOK_SECRET` and configure the
provider to send it as `x-webhook-token` (or `?token=`). Without the secret set,
webhooks are accepted unauthenticated (dev only — always set it in production).

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

Rendering and the send path are covered by `backend/tests/emailService.test.js`.
