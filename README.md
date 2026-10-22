# StellarEduPay

A production-grade, multi-tenant school fee payment system built on the Stellar blockchain. StellarEduPay delivers transparent, immutable, and verifiable fee payments — eliminating manual reconciliation, reducing fraud, and providing instant proof of payment for schools and parents alike.

[![CI](https://github.com/StellarEdu/StellarEduPay/actions/workflows/ci.yml/badge.svg)](https://github.com/StellarEdu/StellarEduPay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.11.0-brightgreen)](https://nodejs.org/)

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Solution Overview](#solution-overview)
- [How Stellar Integration Works](#how-stellar-integration-works)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Application](#running-the-application)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Security](#security)
- [Testing](#testing)
- [Monitoring & Observability](#monitoring--observability)
- [Database Migrations](#database-migrations)
- [Backup & Recovery](#backup--recovery)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Changelog](#changelog)
- [Contributing](#contributing)
- [License](#license)

---

## Problem Statement

Traditional school fee payment systems face several challenges:

- **Manual Reconciliation**: Schools spend hours matching bank deposits to student records
- **Lack of Transparency**: Parents have no immediate proof of payment
- **Fraud Risk**: Paper receipts can be forged or lost
- **Delayed Confirmation**: Bank transfers take days to confirm
- **High Transaction Fees**: Traditional payment processors charge significant fees
- **Poor Audit Trail**: Difficult to track payment history and generate reports

## Solution Overview

StellarEduPay leverages the **Stellar blockchain** to solve these problems:

1. **Instant Verification**: Payments confirmed on-chain within 3–5 seconds
2. **Immutable Records**: Every transaction is permanently recorded
3. **Automatic Reconciliation**: Student IDs embedded in transaction memos enable zero-touch matching
4. **Low Fees**: Stellar charges ~$0.000001 per transaction
5. **Transparent Audit Trail**: Anyone can verify payments on public blockchain explorers
6. **Multi-Asset Support**: Accept XLM (Stellar Lumens) or USDC (stablecoin)

---

## How Stellar Integration Works

### Payment Flow

```
┌─────────────┐
│   Parent    │
│   Wallet    │
└──────┬──────┘
       │ 1. Send XLM/USDC with student ID as memo
       ▼
┌──────────────────────────────────┐
│    Stellar Blockchain Network    │
│  (Transaction recorded in ~5s)   │
└──────┬───────────────────────────┘
       │ 2. Transaction confirmed
       ▼
┌─────────────┐
│   School    │
│   Wallet    │
└──────┬──────┘
       │ 3. Background poller syncs via Horizon API
       ▼
┌────────────────────────────────────────┐
│         StellarEduPay Backend          │
│  • Reads transaction from blockchain   │
│  • Decrypts/extracts memo (student ID) │
│  • Validates amount against fee        │
│  • Updates student payment status      │
│  • Fires webhook & SSE event           │
│  • Emits receipt                       │
└────────────────────────────────────────┘
```

### The Memo Field: Automatic Payment Matching

Stellar transactions include an optional **memo field** (up to 28 characters). StellarEduPay uses this to embed the student ID:

```
Transaction Details:
  From:   Parent's Wallet (GPARENT...)
  To:     School Wallet (GSCHOOL...)
  Amount: 250 XLM
  Memo:   "STU001"   ← Student ID for automatic matching
```

### Read-Only Blockchain Integration

The backend **never holds the school's private key**. It only:
- **Reads** transactions from the public Stellar Horizon API
- **Verifies** payment amounts and memos
- **Records** payment metadata in MongoDB

The school administrator controls their wallet privately through their own Stellar wallet application.

### Accepted Assets

| Asset | Type | Description |
|-------|------|-------------|
| **XLM** | Native | Stellar's native cryptocurrency |
| **USDC** | Stablecoin | USD-pegged stablecoin for price stability |

Assets are configured per school and can be extended in [`backend/src/config/stellarConfig.js`](backend/src/config/stellarConfig.js).

---

## Key Features

> **Status:** the features below are not yet verified end-to-end on `main`: automatic intent-memo payment detection, path payments, SMS reminders, Horizon rate limiting, audit trail completeness, and the SEP-24 anchor flow. They are tracked in [#1802](https://github.com/StellarEdu/StellarEduPay/issues/1802) and should be read as beta until that work lands.

**Blockchain & Payments**
- Blockchain-based payments with automatic on-chain reconciliation
- Multi-asset support (XLM, USDC) configurable per school
- Fee validation: exact match, overpayment, underpayment detection
- Idempotent payment verification (safe to retry without double-recording)
- Suspicious payment detection with configurable multiplier thresholds
- Fee Bump transaction support

**Multi-School & Authentication**
- Multi-tenant architecture: isolated wallets, students, and records per school
- JWT authentication with refresh tokens and HttpOnly cookie storage
- TOTP-based multi-factor authentication (MFA)
- Step-up authentication for sensitive admin operations
- Role-based access (admin vs. parent)
- Per-school student registration quotas

**Reliability & Resilience**
- Durable transaction queue (BullMQ/Redis or MongoDB fallback)
- Automatic retry for failed verifications with exponential backoff
- Circuit breaker on the Stellar Horizon client
- Concurrent request handling with configurable queue and circuit breaker
- Graceful shutdown (SIGTERM/SIGINT) with in-flight request drain
- Stuck-payment reconciliation on startup

**Operations & Observability**
- JSON-structured logs via Winston with daily rotation
- Prometheus metrics endpoint (`/metrics`)
- Grafana dashboard provisioning (included)
- Health check endpoint (`/health`) with degraded/unhealthy states
- Server-Sent Events (SSE) for real-time payment notifications
- Configurable log level at runtime via admin API

**Data & Compliance**
- Payment plans (installment support)
- Fee adjustment engine with composable rules
- Dispute management workflow
- Payment receipts
- Audit log with pagination, date filtering, and TTL cleanup
- Soft-delete for students and fee structures
- PII protection (student data redaction)

**Developer Experience**
- OpenAPI/Swagger docs at `/api/docs` (development mode)
- Database migrations runner with 16 bundled migrations
- Seed script for local development
- Comprehensive test suite (unit + integration, 100+ test files)
- Docker Compose with MongoDB replica set, Redis, automated backups, and Prometheus/Grafana

---

## Architecture

StellarEduPay is a three-tier application:

```
┌────────────────────────────────────────────────────────────────┐
│                     Parent / Admin Browser                     │
└───────────────────────────┬────────────────────────────────────┘
                            │ HTTPS
                            ▼
┌────────────────────────────────────────────────────────────────┐
│              Next.js Frontend (React)                          │
│  Payment forms · Student dashboard · Disputes · Audit logs     │
└───────────────────────────┬────────────────────────────────────┘
                            │ REST API / SSE
                            ▼
┌────────────────────────────────────────────────────────────────┐
│             Express.js Backend (Node.js 24+)                   │
│  Auth · Payments · Students · Schools · Reports · Webhooks     │
│  Fee Adjustments · Disputes · Receipts · Audit Logs            │
└──────────┬─────────────────────────────────┬───────────────────┘
           │                                 │
           ▼                                 ▼
┌──────────────────────┐       ┌─────────────────────────────┐
│      MongoDB         │       │    Stellar Horizon API      │
│  (Replica Set)       │       │  Transaction ledger         │
│  Students · Payments │       │  Account info · Assets      │
│  Schools · Audit     │       └─────────────────────────────┘
└──────────────────────┘
           │
           ▼
┌──────────────────────┐
│        Redis         │
│  BullMQ queues       │
│  Rate-limit counters │
└──────────────────────┘
```

### Key Backend Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| Express App | `backend/src/app.js` | HTTP server, middleware, route mounting |
| Stellar Service | `backend/src/services/stellarService.js` | Horizon API, fee validation, transaction parsing |
| Transaction Polling | `backend/src/services/transactionPollingService.js` | Background blockchain sync |
| Transaction Queue | `backend/src/queue/transactionQueue.js` | Durable BullMQ processing queue |
| Retry Service | `backend/src/services/retryServiceSelector.js` | BullMQ or MongoDB retry backend |
| Webhook Service | `backend/src/services/webhookService.js` | HMAC-signed outbound webhooks |
| Audit Service | `backend/src/services/auditService.js` | Immutable audit log writes |
| Report Service | `backend/src/services/reportService.js` | CSV/JSON report generation |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Stellar Network + Stellar SDK v12 |
| Backend | Node.js 24+ · Express 4 |
| Database | MongoDB 7 (Replica Set) · Mongoose 8 |
| Queue | BullMQ 5 · Redis 7 |
| Frontend | Next.js (React) |
| Auth | JWT · jsonwebtoken · TOTP (MFA) |
| Observability | Winston · Prometheus (prom-client) · Grafana |
| Testing | Jest 29 · Supertest |
| DevOps | Docker · Docker Compose v2 · GitHub Actions |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 24 ([download](https://nodejs.org/))
- **MongoDB 7** running as a **replica set** (required for multi-document transactions)
- **Redis 7** (required for BullMQ; the service degrades gracefully without it but Redis is recommended for production)
- **Git**
- **Docker + Docker Compose v2** (optional, but easiest path)

> **MongoDB Replica Set**: StellarEduPay uses MongoDB multi-document transactions to atomically record payments. A standalone `mongod` will fail at runtime.
>
> For local development without Docker:
> ```bash
> mongod --replSet rs0 --dbpath /path/to/data
> # Once, in a separate terminal:
> mongosh --eval "rs.initiate()"
> ```
> Then use `MONGO_URI=mongodb://localhost:27017/stellaredupay?replicaSet=rs0`.
>
> Docker Compose handles this automatically.

### Installation

#### Step 1: Clone the repository

```bash
git clone https://github.com/yourusername/StellarEduPay.git
cd StellarEduPay
```

#### Step 2: Generate a school wallet

```bash
cd backend
npm install
npm run create-wallet
```

This outputs a **Public Key** (`G...`) and a **Secret Key** (`S...`). Copy the public key — you need it in your `.env`. **Never commit the secret key.**

Alternatively, use [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test) and click "Fund account with Friendbot" to activate the testnet account.

#### Step 3: Install dependencies

```bash
# From project root
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### Configuration

#### Step 4: Configure the backend

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`. The minimum required values are:

```bash
MONGO_URI=mongodb://localhost:27017/stellaredupay?replicaSet=rs0
SCHOOL_WALLET_ADDRESS=G...          # Public key from Step 2
STELLAR_NETWORK=testnet             # or mainnet
JWT_SECRET=<random 64-char string>  # openssl rand -hex 32
```

See [Environment Variables](#environment-variables) for the full reference.

#### Step 5: Configure the frontend

```bash
cp frontend/.env.local.example frontend/.env.local
# Defaults to NEXT_PUBLIC_API_URL=/api (same-origin via the Next.js proxy)
```

### Running the Application

#### Option A: Docker Compose (recommended)

```bash
# Fund your testnet wallet first (Step 2), then:
SCHOOL_WALLET_ADDRESS=G... docker compose up --build
```

This starts MongoDB (replica set), Redis, backend, frontend, and a nightly backup container. Prometheus + Grafana are available via the monitoring compose file:

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up --build
```

#### Option B: Local development

**Terminal 1 — MongoDB:**
```bash
mongod --replSet rs0 --dbpath /path/to/data
```

**Terminal 2 — Backend:**
```bash
cd backend && npm run dev
```

Expected output:
```
MongoDB connected
Server running on port 5000
Background polling started
Retry worker started
```

**Terminal 3 — Frontend:**
```bash
cd frontend && npm run dev
```

Visit **http://localhost:3000**.

#### Step 6: Run database migrations

```bash
node scripts/migrate.js
```

Migrations are idempotent and safe to re-run.

#### Step 7: Seed sample data (optional)

```bash
node scripts/seed-test-data.js          # Upsert (safe to re-run)
node scripts/seed-test-data.js --clean  # Drop and recreate
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `MONGO_URI` | MongoDB connection string (must include replica set) |
| `STELLAR_NETWORK` | `testnet` or `mainnet` |
| `JWT_SECRET` | Secret for signing JWTs (min 32 chars, keep private) |
| `RECEIPT_SIGNATURE_SECRET` | Secret used to sign payment receipts |

> `SCHOOL_WALLET_ADDRESS` is optional. Each school's wallet is stored on its school record; the variable is only read by the legacy default-school backfill migration.

### Stellar

| Variable | Default | Description |
|----------|---------|-------------|
| `STELLAR_HORIZON_URL` | Auto from network | Override Horizon API URL (alias: `HORIZON_URL`) |
| `STELLAR_HORIZON_URLS` | — | Comma-separated, priority-ordered Horizon URLs for failover. Falls back to `STELLAR_HORIZON_URL`. |
| `STELLAR_TIMEOUT_MS` | `10000` | Timeout for a single Horizon request |
| `USDC_ISSUER` | Auto from network | USDC issuer address |

### Payments

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_PAYMENT_AMOUNT` | `0.01` | Minimum payment in XLM/USDC |
| `MAX_PAYMENT_AMOUNT` | `100000` | Maximum payment in XLM/USDC |
| `ACCEPTED_ASSET` | `XLM` | Asset accepted for fee payments: `XLM` or `USDC` |
| `CONFIRMATION_THRESHOLD` | `2` | Confirmations required before a payment is treated as confirmed |
| `FINALIZATION_THRESHOLD` | — | Confirmations required before a payment is finalized |

### Background Jobs

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | `30000` | Blockchain sync interval |
| `RETRY_INTERVAL_MS` | `60000` | Failed-verification retry interval |
| `RETRY_MAX_ATTEMPTS` | `10` | Max retry attempts before giving up |
| `SYNC_INTERVAL_MS` | — | Override for the transaction sync interval |
| `SYNC_LOCK_TTL_MS` | `60000` | Lifetime of a per-school sync lock |
| `MAX_QUEUE_DEPTH` | `1000` | Queue depth limit; polling backs off as the queue approaches it |
| `QUEUE_BACKPRESSURE_HIGH_WATER` | — | Queue depth at which polling pauses |
| `QUEUE_BACKPRESSURE_LOW_WATER` | — | Queue depth at which polling resumes |
| `REMINDER_INTERVAL_MS` | `3600000` | How often the fee-reminder scheduler runs |
| `REMINDER_COOLDOWN_HOURS` | `48` | Minimum hours between reminders to the same parent |
| `REMINDER_MAX_COUNT` | `5` | Maximum reminders sent per student |

### Redis / BullMQ

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | — | Redis hostname. When unset, falls back to MongoDB retry backend. |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis auth password |

> Without `REDIS_HOST`, rate-limit counters are in-process only and reset on restart. Redis is strongly recommended for production.

### Security & Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUSTED_PROXY_HOPS` | `1` | Reverse-proxy hops for real IP resolution |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `VERIFY_RATE_LIMIT` | `10` | Max verify requests per minute |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS origins |
| `APP_URL` | — | Base URL of the application (required in production) |
| `JWT_ACCESS_TOKEN_TTL` | `8h` | Access-token lifetime: a number with an optional `s`, `m`, `h` or `d` suffix (e.g. `15m`). Invalid values fall back to the default. |
| `JWT_REFRESH_TOKEN_TTL` | `30d` | Refresh-token lifetime, same format as `JWT_ACCESS_TOKEN_TTL` |
| `STUDENT_PII_ENCRYPTION_KEY` | — | Hex key from which the student PII encryption key is derived |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | — | Key from which stored webhook secrets are encrypted. Rotate with `WEBHOOK_SECRET_ENCRYPTION_KEY_OLD` / `_PREVIOUS`. |
| `AUDIT_HMAC_KEY` | `JWT_SECRET` | HMAC key for audit-log integrity. Set it to keep the audit secret separate from the JWT secret. |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | HTTP server port |
| `NODE_ENV` | — | Set to `production` to disable Swagger UI and enable combined logs |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown deadline |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `MAX_BODY_SIZE` | `1mb` | Request body size limit |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |

### Data & Compliance

| Variable | Default | Description |
|----------|---------|-------------|
| `STUDENT_PII_RETENTION_DAYS` | `90` | Days after a student is soft-deleted before their PII is cleared |

### SMTP (email)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | — | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_SECURE` | `false` | Use TLS from the first byte (`true` for port 465) |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | — | Sender address on outgoing email |

### Docker Compose Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_ROOT_USERNAME` | `root` | MongoDB root username |
| `MONGO_ROOT_PASSWORD` | `password` | MongoDB root password (**change in production**) |
| `BACKEND_MEM_LIMIT` | `512m` | Backend container memory limit |
| `FRONTEND_MEM_LIMIT` | `256m` | Frontend container memory limit |
| `REDIS_MEM_LIMIT` | `128m` | Redis container memory limit |
| `MONGO_MEM_LIMIT` | `1g` | MongoDB container memory limit |
| `BACKUP_DIR` | `./backups` | Host path for MongoDB backups |
| `RETAIN_DAYS` | `7` | Days of backups to retain |

---

## API Reference

The HTTP contract lives in [`backend/openapi.json`](backend/openapi.json), generated from the routers by `node scripts/openapi/generate.js` and enforced in CI (`node scripts/openapi/check-contract.js`). It is served at `GET /api/docs.json` (or `/api/docs` in development). In production (unless `SWAGGER_ENABLED=true`) `/api/docs.json` requires admin authentication. [`docs/api-spec.md`](docs/api-spec.md) has the full endpoint index plus request/response examples; the list below is a summary.

### Authentication

```
POST /api/auth/login       Login (returns JWT in HttpOnly cookie + response body)
POST /api/auth/refresh     Refresh access token
POST /api/auth/logout      Invalidate session
POST /api/auth/mfa/setup   Set up TOTP MFA
POST /api/auth/mfa/verify  Verify TOTP code
```

### Schools

```
POST   /api/schools            Create a school
GET    /api/schools            List schools
GET    /api/schools/:id        Get school details
PATCH  /api/schools/:id        Update school
DELETE /api/schools/:id        Delete school
```

### Students

```
POST   /api/students           Register a student (auto-assigns fee from class)
GET    /api/students           List students (paginated)
GET    /api/students/:id       Get student
PATCH  /api/students/:id       Update student
DELETE /api/students/:id       Soft-delete student
POST   /api/students/bulk      Bulk import via CSV (respects school quota)
```

### Payments

```
GET    /api/payments/instructions/:studentId   Payment instructions (wallet, memo, assets)
POST   /api/payments/verify                    Verify a transaction by hash
POST   /api/payments/sync                      Sync latest transactions from blockchain
GET    /api/payments/:studentId                Payment history for a student
GET    /api/payments/accepted-assets           Accepted assets for the school
GET    /api/payments/limits                    Payment min/max limits
GET    /api/payments/overpayments              List overpaid transactions (paginated)
GET    /api/payments/pending                   List pending verifications (paginated)
```

### Fee Structures

```
POST   /api/fees               Create a fee structure
GET    /api/fees               List fee structures
GET    /api/fees/:className    Get fee for a class
PUT    /api/fees/:className    Update fee structure
DELETE /api/fees/:className    Soft-delete fee structure
```

### Fee Adjustments

```
POST   /api/fee-adjustments            Create adjustment rule
GET    /api/fee-adjustments            List rules
PUT    /api/fee-adjustments/:id        Update rule
DELETE /api/fee-adjustments/:id        Delete rule
```

### Payment Plans

```
POST   /api/payment-plans/:studentId                              Create installment plan
GET    /api/payment-plans/:studentId                              Get plan for student
PATCH  /api/payment-plans/:studentId/installment/:installmentIndex Update an installment
DELETE /api/payment-plans/:studentId                              Cancel plan
```

### Disputes

```
POST   /api/disputes           Open a dispute
GET    /api/disputes           List disputes
PATCH  /api/disputes/:id/resolve  Resolve a dispute
```

### Reports

```
GET    /api/reports            Generate payment report (date range, CSV or JSON)
```

### Receipts

```
GET    /api/receipts/:txHash   Download payment receipt
```

### Audit Logs

```
GET    /api/audit              Paginated audit log with date/actor filters
```

### Reminders

```
POST   /api/reminders/trigger  Trigger payment reminder emails
GET    /api/reminders/preview  Preview who would be reminded
```

### Admin

```
GET    /api/admin/retry-queue/stats Retry queue depth and status
POST   /api/admin/log-level         Change log level at runtime
GET    /api/consistency             Run data consistency check
```

### System

```
GET    /health                 Health check (ok / degraded / unhealthy)
GET    /metrics                Prometheus metrics
GET    /api/docs               Swagger UI (development only)
GET    /api/docs.json          OpenAPI spec JSON (admin auth in production)
```

### Error Response Format

All errors use a consistent shape:

```json
{
  "error": "Human-readable description",
  "code": "ERROR_CODE"
}
```

Common error codes: `NOT_FOUND`, `VALIDATION_ERROR`, `DUPLICATE_TX`, `TX_FAILED`, `MISSING_MEMO`, `INVALID_DESTINATION`, `UNSUPPORTED_ASSET`, `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `STELLAR_NETWORK_ERROR`, `STUDENT_QUOTA_EXCEEDED`, `ASSET_NOT_ACCEPTED`, `UNAUTHORIZED`, `FORBIDDEN`.

---

## Security

- **JWT + HttpOnly cookies**: Access tokens are short-lived; refresh tokens stored in HttpOnly cookies to prevent XSS theft.
- **TOTP MFA**: Optional per-admin TOTP second factor.
- **Step-up authentication**: Sensitive operations require re-authentication regardless of session state.
- **Helmet**: Strict CSP (`default-src 'none'`), `X-Frame-Options`, and other security headers.
- **CORS**: Configurable allow-list via `ALLOWED_ORIGINS`.
- **Rate limiting**: Per-IP rate limiting with Redis persistence; dedicated stricter limit on `/api/payments/verify`.
- **Request queue + circuit breaker**: Protects downstream services from overload.
- **Webhook HMAC signatures**: Outbound webhooks are signed with `HMAC-SHA256` so receivers can verify authenticity.
- **No private key storage**: The backend never holds the school's Stellar secret key.
- **Proxy trust**: Configurable `TRUSTED_PROXY_HOPS` prevents IP spoofing via `X-Forwarded-For`.
- **Body size limit**: Configurable `MAX_BODY_SIZE` to prevent request flood attacks.

See [`docs/security.md`](docs/security.md) for a full threat model.

---

## Testing

Tests mock both the Stellar SDK and MongoDB — no real network or database required.

```bash
# All tests (from project root)
npm test

# Backend tests only
cd backend && npm test

# Specific test file
npm test tests/stellar.test.js

# Integration tests (requires live Stellar testnet)
npm run test:integration

# Docker Compose health check tests
npm run test:docker-healthcheck
```

The test suite covers: Stellar service, payment API, payment limits, authentication, MFA, JWT refresh, disputes, fee adjustments, audit logs, webhooks, idempotency, concurrent processing, rate limiting, graceful shutdown, multi-asset support, currency conversion, source validation rules, SSE, and more.

---

## Monitoring & Observability

### Health Check

```
GET /health
```

| Response | Meaning |
|----------|---------|
| `200 { "status": "ok" }` | All systems healthy |
| `200 { "status": "degraded", "details": {...} }` | App is up but a subsystem (e.g. Horizon) is unreachable |
| `503 { "status": "unhealthy" }` | MongoDB disconnected or a critical worker crashed |

### Prometheus + Grafana

Start the monitoring stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up
```

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (datasource pre-provisioned)
- Metrics endpoint: `http://localhost:5000/metrics`

### Log Format

Structured JSON to stdout:

```json
{
  "level": "info",
  "msg": "Payment synced",
  "schoolId": "SCH-DEFAULT",
  "txHash": "abc123...",
  "studentId": "STU001",
  "amount": 250,
  "ts": "2026-03-24T10:00:00.000Z"
}
```

### Logging Configuration

#### Log Levels

The application supports four log levels (from least to most verbose):

| Level | Use Case |
|-------|----------|
| `error` | Production: only errors. Minimal overhead, best for high-volume services. |
| `warn` | Warnings and errors. Good for production health monitoring. |
| `info` | **Development default.** Info + warnings + errors. Readable without spam. |
| `debug` | All events including low-level operations. Use only for troubleshooting. |

#### Setting Log Level

**Via environment variable (startup):**
```bash
LOG_LEVEL=debug npm start        # Set at startup
LOG_LEVEL=warn npm start         # Production mode
```

Default is `info`.

**At runtime (no restart needed):**
```bash
# Change log level via admin API
curl -X POST http://localhost:5000/api/admin/log-level \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"level": "debug"}'

# Response
{ "previous": "info", "current": "debug" }
```

Verify current level at any time:
```bash
curl http://localhost:5000/health | jq .logLevel
```

#### Suppressing Third-Party Noise

In development (`NODE_ENV != production`), the backend automatically suppresses verbose logging from:
- **ioredis** — Redis connection/reconnection spam
- **mongoose** — Schema validation debug info

This keeps the console output clean at the default `info` level. To see low-level details:
```bash
LOG_LEVEL=debug npm run dev
```

#### File Logging

Application logs are also written to disk with daily rotation:
- **Combined:** `logs/combined-YYYY-MM-DD.log` (all levels)
- **Errors only:** `logs/error-YYYY-MM-DD.log` (errors only)

Configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_MAX_SIZE` | `100m` | Size before file rotation |
| `LOG_MAX_FILES` | `14d` | Keep this many rotated files |

Examples:
```bash
# Keep larger files
LOG_MAX_SIZE=500m npm start

# Shorter retention
LOG_MAX_FILES=7d npm start
```

### Recommended Alerting Thresholds

| Alert | Warning | Critical |
|-------|---------|----------|
| Sync lag (`lastSyncAt` age) | 5 min | 15 min |
| Retry queue depth | > 50 | > 200 |
| Payment processing time (p95) | > 10s | — |
| Health check returning 503 | — | 2 consecutive |
| Error log rate | > 10/min | — |

---

## Database Migrations

Migrations live in `backend/migrations/` and are tracked in a `migrations` collection.

```bash
node scripts/migrate.js
```

Migrations are idempotent — safe to run repeatedly. The runner skips already-applied migrations.

Current migrations include: audit log TTL index, student indexes, idempotency key TTL, payment intent TTL, report indexes, pending verification indexes, student soft-delete backfill, school slug uniqueness, webhook secret seeding, and audit log compound index.

---

## Backup & Recovery

The Docker Compose `backup` service runs `mongodump` every 24 hours and retains 7 days of archives.

```bash
# Manual backup
./scripts/backup.sh

# Restore from archive
./scripts/restore.sh backups/20260324T120000Z.gz
```

Configuration:

```bash
export BACKUP_DIR=./backups   # host path for backup archives
export RETAIN_DAYS=7          # days of backups to keep
```

---

## Project Structure

```
StellarEduPay/
├── backend/
│   ├── migrations/            # Numbered database migration scripts
│   ├── src/
│   │   ├── app.js             # Express server, middleware, startup
│   │   ├── config/            # Environment config, Stellar config, Swagger, DB
│   │   ├── controllers/       # Route handlers
│   │   ├── events/            # Node.js EventEmitter (paymentSaved)
│   │   ├── middleware/        # Auth, rate limiting, validation, request logger
│   │   ├── metrics/           # Prometheus counters and gauges
│   │   ├── models/            # Mongoose schemas
│   │   ├── queue/             # BullMQ transaction queue
│   │   ├── routes/            # Express routers
│   │   ├── services/          # Business logic, Stellar, webhooks, polling
│   │   ├── templates/         # Email HTML/text templates
│   │   └── utils/             # Helpers: logger, crypto, validation
│   ├── tests/                 # Backend-scoped unit tests
│   ├── Dockerfile
│   ├── .env.example
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── components/        # React components
│   │   ├── hooks/             # Custom React hooks
│   │   ├── pages/             # Next.js pages
│   │   ├── services/          # API client, currency service
│   │   ├── styles/            # Global CSS
│   │   └── utils/             # Frontend helpers
│   ├── public/
│   ├── Dockerfile
│   └── package.json
│
├── docs/                      # Architecture, API spec, integration guides
├── monitoring/                # Prometheus config, Grafana provisioning
├── scripts/                   # Wallet generation, seed, migrations, backup
├── tests/                     # Root-level integration & e2e tests
├── deploy/k8s/                # Kubernetes deployment sample
├── docker-compose.yml
├── docker-compose.monitoring.yml
└── package.json               # Root: runs tests across all packages
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | System design and data flow |
| [`docs/api-spec.md`](docs/api-spec.md) | Full API reference |
| [`docs/stellar-integration.md`](docs/stellar-integration.md) | Stellar-specific details |
| [`docs/payment-limits.md`](docs/payment-limits.md) | Payment limits configuration |
| [`docs/security.md
