# StellarEduPay Documentation

Every document in `docs/` is **living documentation**: it describes how the
system works *today* and is updated in the same PR as the code it describes.
If you find a document that no longer matches the code, fix it or open an issue.

**Owner** is the area responsible for keeping a document accurate.
**Last reviewed** is the date someone last checked the whole document against
the code. Bump it whenever you do that, not just when you edit one line.

> PR descriptions, implementation summaries and "what this PR changed" notes
> belong in the pull request, not in `docs/`. See
> [CONTRIBUTING.md](../CONTRIBUTING.md#documentation-rules).

## Getting started

| Document | What it covers | Owner | Last reviewed |
|---|---|---|---|
| [QUICK_START_DOCKER.md](QUICK_START_DOCKER.md) | Run the whole stack locally with Docker Compose | Platform | 2026-09-29 |
| [architecture.md](architecture.md) | System overview: frontend, backend, MongoDB, Redis, Stellar | Backend | 2026-09-29 |
| [stellar-integration.md](stellar-integration.md) | Horizon usage, memos, sync/verify flows, finality, fraud controls, wallet funding check | Payments | 2026-10-17 |

## API and integrations

| Document | What it covers | Owner | Last reviewed |
|---|---|---|---|
| [backend/openapi.json](../backend/openapi.json) | Machine-readable route contract (paths, methods, auth) — enforced in CI | Backend | 2026-10-17 |
| [api-spec.md](api-spec.md) | Human-readable API reference: request/response examples | Backend | 2026-09-29 |
| [WEBHOOK_INTEGRATION.md](WEBHOOK_INTEGRATION.md) | Outbound webhooks: events, signatures, retries | Backend | 2026-09-27 |
| [qr-code-payments.md](qr-code-payments.md) | SEP-7 / QR payment links for parents | Payments | 2026-07-20 |
| [email-delivery.md](email-delivery.md) | Email providers, retries, bounce/complaint handling | Backend | 2026-09-27 |
| [admin-ui.md](admin-ui.md) | Admin pages, routing and auth wrapping | Frontend | 2026-09-29 |

## Payments domain

| Document | What it covers | Owner | Last reviewed |
|---|---|---|---|
| [payment-limits.md](payment-limits.md) | Minimum / maximum payment thresholds | Payments | 2026-07-20 |
| [payment-plans-underpaid-reconciliation.md](payment-plans-underpaid-reconciliation.md) | How payment plans and underpayment reconciliation interact | Payments | 2026-08-30 |
| [idempotency-payment-verification.md](idempotency-payment-verification.md) | Idempotent `POST /api/payments/verify` | Payments | 2026-08-30 |
| [horizon-rate-limits.md](horizon-rate-limits.md) | Horizon rate limits, poll budgeting, sync-delay SLA | Payments | 2026-08-29 |
| [retry-backends.md](retry-backends.md) | Transaction retry contract, BullMQ worker, dead-letter strategy | Backend | 2026-06-30 |

## Security and privacy

| Document | What it covers | Owner | Last reviewed |
|---|---|---|---|
| [security.md](security.md) | MFA, key management, encryption at rest, secret rotation | Security | 2026-09-28 |
| [threat-model.md](threat-model.md) | STRIDE threat model | Security | 2026-07-04 |
| [privacy.md](privacy.md) | Personal data handling, retention, data-subject rights | Security | 2026-09-27 |
| [dependency-triage.md](dependency-triage.md) | Triage process for dependency security advisories | Security | 2026-07-20 |

## Operations

| Document | What it covers | Owner | Last reviewed |
|---|---|---|---|
| [operator-runbooks.md](operator-runbooks.md) | Incident runbooks, key rotation, backups (RPO/RTO), restore, deploys | Platform | 2026-10-17 |
| [runbooks/price-feed-staleness.md](runbooks/price-feed-staleness.md) | Alert runbook: price feed staleness | Platform | 2026-06-30 |
| [runbooks/wallet-rotation.md](runbooks/wallet-rotation.md) | Runbook: rotating a school's receiving wallet | Payments | 2026-08-30 |
| [docker-health-checks.md](docker-health-checks.md) | Container health checks and startup ordering | Platform | 2026-09-27 |
| [redis-dependency.md](redis-dependency.md) | What depends on Redis and how it degrades | Platform | 2026-09-29 |
| [migrations.md](migrations.md) | Writing and running database migrations | Backend | 2026-09-28 |
| [error-handling.md](error-handling.md) | Process-level error handling policy | Backend | 2026-07-27 |

## Contributing and testing

| Document | What it covers | Owner | Last reviewed |
|---|---|---|---|
| [issue-intake.md](issue-intake.md) | Where and how to file issues | Maintainers | 2026-07-28 |
| [coverage-thresholds.md](coverage-thresholds.md) | Jest coverage thresholds | Maintainers | 2026-08-31 |
| [testing-sync-payments.md](testing-sync-payments.md) | Test coverage for unmatched/missing memo sync cases | Payments | 2026-07-29 |
| [load-simulation.md](load-simulation.md) | Discrete-event model of Horizon polling under load | Payments | 2026-08-30 |

## Design decisions

Record an architectural decision as a dated file in `docs/adr/`
(`NNNN-short-title.md`: context, decision, consequences). ADRs record a
decision; they are not a log of what a PR changed.
