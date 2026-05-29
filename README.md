# StellarEduPay

A decentralized school fee payment system built on the Stellar blockchain network. StellarEduPay enables transparent, immutable, and verifiable school fee payments — eliminating manual reconciliation, reducing fraud, and providing instant proof of payment for both schools and parents.

[![CI](https://github.com/manuelusman73-png/StellarEduPay/actions/workflows/ci.yml/badge.svg)](https://github.com/manuelusman73-png/StellarEduPay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 📋 Table of Contents

- [Problem Statement](#-problem-statement)
- [Solution Overview](#-solution-overview)
- [How Stellar Integration Works](#-how-stellar-integration-works)
- [Key Features](#-key-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Funding Your Testnet Wallet with Friendbot](#funding-your-testnet-wallet-with-friendbot)
  - [Configuration](#configuration)
  - [Running the Application](#running-the-application)
- [Environment Variables](#-environment-variables)
- [API Usage Examples](#-api-usage-examples)
- [Testing](#-testing)
- [Project Structure](#-project-structure)
- [Documentation](#-documentation)
- [Changelog](#-changelog)
- [Monitoring & Observability](#-monitoring--observability)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎯 Problem Statement

Traditional school fee payment systems face several challenges:

- **Manual Reconciliation**: Schools spend hours matching bank deposits to student records
- **Lack of Transparency**: Parents have no immediate proof of payment
- **Fraud Risk**: Paper receipts can be forged or lost
- **Delayed Confirmation**: Bank transfers take days to confirm
- **High Transaction Fees**: Traditional payment processors charge significant fees
- **Poor Audit Trail**: Difficult to track payment history and generate reports

## 💡 Solution Overview

StellarEduPay leverages the **Stellar blockchain network** to solve these problems:

1. **Instant Verification**: Payments are confirmed on the blockchain within 3-5 seconds
2. **Immutable Records**: Every transaction is permanently recorded and cannot be altered
3. **Automatic Reconciliation**: Student IDs embedded in transaction memos enable automatic matching
4. **Low Fees**: Stellar transactions cost a fraction of a cent
5. **Transparent Audit Trail**: Anyone can verify payments on public blockchain explorers
6. **Multi-Asset Support**: Accept payments in XLM (Stellar Lumens) or USDC (stablecoin)

---

## 🌟 How Stellar Integration Works

### The Stellar Blockchain

[Stellar](https://stellar.org) is a decentralized, open-source blockchain network designed for fast, low-cost financial transactions. Unlike traditional payment systems, Stellar:

- Confirms transactions in **3-5 seconds**
- Charges **0.00001 XLM per transaction** (~$0.000001)
- Supports **multiple currencies** (XLM, USDC, and custom tokens)
- Provides **public transaction records** for transparency

### Payment Flow with Stellar

```
┌─────────────┐
│   Parent    │
│   Wallet    │
└──────┬──────┘
       │ 1. Send XLM/USDC with student ID as memo
       │
       ▼
┌─────────────────────────────────────────┐
│      Stellar Blockchain Network         │
│  (Transaction recorded immutably)       │
└──────┬──────────────────────────────────┘
       │ 2. Transaction confirmed in 3-5 seconds
       │
       ▼
┌─────────────┐
│   School    │
│   Wallet    │
└──────┬──────┘
       │ 3. Backend syncs from Horizon API
       │
       ▼
┌─────────────────────────────────────────┐
│      StellarEduPay Backend              │
│  • Reads transaction from blockchain    │
│  • Extracts memo (student ID)           │
│  • Validates amount against fee         │
│  • Updates student payment status       │
└─────────────────────────────────────────┘
```

### The Memo Field: Automatic Payment Matching

Stellar transactions include an optional **memo field** (up to 28 characters). StellarEduPay uses this to embed the student ID:

```
Transaction Details:
  From:   Parent's Wallet (GPARENT...)
  To:     School Wallet (GSCHOOL...)
  Amount: 250 XLM
  Memo:   "STU001"  ← Student ID for automatic matching
```

When the backend syncs transactions, it:
1. Reads the memo field
2. Matches it to a registered student
3. Validates the amount against the student's fee
4. Automatically updates the payment status

**No manual reconciliation needed!**

### Read-Only Integration

**Important**: The backend never holds or requires the school's private key. It only:
- **Reads** transactions from the public Stellar Horizon API
- **Verifies** payment amounts and memos
- **Records** payment metadata in MongoDB

The school administrator controls the wallet privately through their own Stellar wallet application.

### Accepted Assets

StellarEduPay accepts two types of payments:

| Asset | Type | Description |
|-------|------|-------------|
| **XLM** | Native | Stellar's native cryptocurrency (Lumens) |
| **USDC** | Stablecoin | USD-pegged stablecoin for price stability |

Assets are configured in [`backend/src/config/stellarConfig.js`](backend/src/config/stellarConfig.js). Additional assets can be added by updating the configuration.

### Testnet vs Mainnet

- **Testnet**: For development and testing (free test XLM from Friendbot)
- **Mainnet**: For production with real assets

Controlled by the `STELLAR_NETWORK` environment variable.

---

## 🚰 Funding Your Testnet Wallet with Friendbot

When working on the **Stellar Testnet**, every account must be funded before it can send or receive transactions. Friendbot is a free faucet provided by the Stellar Development Foundation that deposits **10,000 test XLM** into any testnet account instantly.

> ⚠️ Friendbot only works on **testnet**. Never use it (or expect it) on mainnet.

### Why You Need This

A newly generated Stellar keypair does not exist on the ledger until it receives its first funding. Attempting to use an unfunded account will result in a `tx_insufficient_balance` or account-not-found error.

### Option 1: Stellar Laboratory (Browser)

1. Go to [https://laboratory.stellar.org/#account-creator?network=test](https://laboratory.stellar.org/#account-creator?network=test)
2. Click **"Generate keypair"** to create a new public/secret key pair, or paste your existing public key.
3. Click **"Fund account with Friendbot"**.
4. You'll see a success response — your account now has 10,000 test XLM.

### Option 2: Friendbot HTTP API (curl)

Replace `YOUR_PUBLIC_KEY` with your actual Stellar public key (starts with `G`):

```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

Successful response:

```json
{
  "hash": "abc123...",
  "result_xdr": "...",
  "_links": { ... }
}
```

### Option 3: JavaScript / Node.js

If you want to fund an account programmatically in a script or test setup:

```js
const { Keypair } = require('@stellar/stellar-sdk');
const fetch = require('node-fetch'); // or use native fetch in Node 18+

async function fundTestnetAccount(publicKey) {
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
  );
  if (!response.ok) {
    throw new Error(`Friendbot failed: ${response.statusText}`);
  }
  const data = await response.json();
  console.log('Account funded! Tx hash:', data.hash);
  return data;
}

// Example usage
const keypair = Keypair.random();
console.log('Public Key:', keypair.publicKey());
console.log('Secret Key:', keypair.secret());

fundTestnetAccount(keypair.publicKey());
```

### Verifying the Balance

After funding, confirm the account exists and check its balance:

```bash
curl "https://horizon-testnet.stellar.org/accounts/YOUR_PUBLIC_KEY" \
  | python -m json.tool | grep -A3 '"balances"'
```

Or visit the Stellar Testnet Explorer:

```
https://stellar.expert/explorer/testnet/account/YOUR_PUBLIC_KEY
```

### Funding in This Project

When setting up StellarEduPay for local development:

1. Generate your school wallet (see [Step 2 in Installation](#installation)).
2. Copy the **Public Key** (`G...`).
3. Run the Friendbot curl command above with that public key.
4. Set `SCHOOL_WALLET_ADDRESS` in `backend/.env` to that public key.
5. The backend will now be able to read incoming testnet transactions for that wallet.

> The backend only reads from the blockchain — it never needs the secret key. Keep your secret key private.

---

## ✨ Key Features

- ✅ **Blockchain-Based Payments**: Immutable, transparent transaction records
- ✅ **Automatic Reconciliation**: Student ID memos enable instant payment matching
- ✅ **Multi-Asset Support**: Accept XLM or USDC payments
- ✅ **Fee Validation**: Automatic detection of underpayments, overpayments, and exact matches
- ✅ **Payment Limits**: Configurable min/max thresholds for security
- ✅ **Transaction Verification**: Verify any payment by transaction hash
- ✅ **Payment History**: Complete audit trail for each student
- ✅ **Retry Mechanism**: Automatic retry for failed verifications during network outages
- ✅ **Background Polling**: Continuous sync of new payments from the blockchain
- ✅ **RESTful API**: Clean, documented endpoints for all operations
- ✅ **Comprehensive Testing**: Full test coverage with Jest

---

## 🏗️ Architecture

StellarEduPay is a three-tier application:

```
┌──────────────────────────────────────────────────────────────┐
│                     Parent/Admin Browser                      │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   Next.js Frontend (React)                    │
│  • Payment forms  • Student dashboard  • Reports             │
└────────────────────────┬─────────────────────────────────────┘
                         │ REST API
                         ▼
┌──────────────────────────────────────────────────────────────┐
│              Express.js Backend (Node.js)                     │
│  • Payment controller  • Stellar service  • Validation       │
└─────────┬────────────────────────────────────┬───────────────┘
          │                                    │
          ▼                                    ▼
┌─────────────────────┐          ┌────────────────────────────┐
│      MongoDB        │          │   Stellar Horizon API      │
│  • Students         │          │  • Transaction ledger      │
│  • Payments         │          │  • Account operations      │
│  • Fee structures   │          │  • Asset information       │
└─────────────────────┘          └────────────────────────────┘
```

### Key Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| **Express App** | [`backend/src/app.js`](backend/src/app.js) | HTTP server, route mounting, error handling |
| **Stellar Service** | [`backend/src/services/stellarService.js`](backend/src/services/stellarService.js) | Ledger sync, transaction verification, fee validation |
| **Stellar Config** | [`backend/src/config/stellarConfig.js`](backend/src/config/stellarConfig.js) | Horizon server, accepted assets, network configuration |
| **Payment Controller** | [`backend/src/controllers/paymentController.js`](backend/src/controllers/paymentController.js) | Payment instructions, verification, sync endpoints |
| **Student Controller** | [`backend/src/controllers/studentController.js`](backend/src/controllers/studentController.js) | Student CRUD, automatic fee assignment |
| **Fee Controller** | [`backend/src/controllers/feeController.js`](backend/src/controllers/feeController.js) | Fee structure management |
| **Retry Service** | [`backend/src/services/retryService.js`](backend/src/services/retryService.js) | Automatic retry for failed verifications |
| **Transaction Service** | [`backend/src/services/transactionService.js`](backend/src/services/transactionService.js) | Background polling for new payments |

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Blockchain** | Stellar Network | Payment ledger and transaction processing |
| **Backend** | Node.js 20+ + Express | REST API server |
| **Database** | MongoDB + Mongoose | Student records and payment metadata |
| **Frontend** | Next.js (React) | User interface |
| **Blockchain SDK** | Stellar SDK | Horizon API integration |
| **Testing** | Jest + Supertest | Unit and integration tests |
| **DevOps** | Docker + Docker Compose | Containerization and deployment |

---

## 🚀 Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** 20 or higher ([Download](https://nodejs.org/)) — specified in `.nvmrc` files
- **npm** 9 or higher (bundled with Node.js)
- **MongoDB** 6.0 or higher, running as a **replica set** ([Download](https://www.mongodb.com/try/download/community) or use [MongoDB Atlas](https://www.mongodb.com/atlas))
- **Git** ([Download](https://git-scm.com/downloads))
- **Docker + Docker Compose v2** (optional, for containerized deployment) ([Download](https://www.docker.com/get-started))

> ⚠️ **MongoDB Replica Set Required**
>
> StellarEduPay uses [MongoDB multi-document transactions](https://www.mongodb.com/docs/manual/core/transactions/) to atomically record a payment and update the student's fee status. MongoDB only supports multi-document transactions on replica sets (or sharded clusters). A standalone `mongod` instance will cause transaction operations to fail at runtime.
>
> **Local development** — start a single-node replica set instead of a plain `mongod`:
> ```bash
> mongod --replSet rs0 --dbpath /path/to/data
> # In a separate terminal, initialise the replica set once:
> mongosh --eval "rs.initiate()"
> ```
> Then use `MONGO_URI=mongodb://localhost:27017/stellaredupay?replicaSet=rs0` in your `.env`.
>
> **Docker Compose** — the provided `docker-compose.yml` already configures MongoDB as a single-node replica set; no extra steps are needed.
>
> **MongoDB Atlas** — all Atlas clusters (including the free M0 tier) run as replica sets by default.

### Installation

#### Step 1: Clone the Repository

```bash
git clone https://github.com/yourusername/StellarEduPay.git
cd StellarEduPay
```

#### Step 2: Generate a School Wallet

You need a Stellar wallet to receive payments. Generate one using the Stellar Laboratory:

**Option A: Using Stellar Laboratory (Recommended for beginners)**

1. Visit [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test)
2. Click "Generate keypair"
3. Copy the **Public Key** (starts with `G...`) — this is your `SCHOOL_WALLET_ADDRESS`
4. **Securely save the Secret Key** (starts with `S...`) — never share this or commit it to version control
5. Click "Fund account with Friendbot" to get free test XLM (testnet only)

**Option B: Using the provided script**

```bash
# From the backend directory (recommended — dependencies are guaranteed to be available)
cd backend
npm install
npm run create-wallet
```

Or from the project root after installing backend dependencies:

```bash
cd backend && npm install && cd ..
node scripts/create-school-wallet.js
```

This will output:
```
Public Key:  G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE
Secret Key:  SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

⚠️  Save the secret key securely! The backend only needs the public key.
```

#### Step 3: Install Dependencies

**Backend:**
```bash
cd backend
npm install
```

**Frontend:**
```bash
cd ../frontend
npm install
```

**Root (for tests):**
```bash
cd ..
npm install
```

### Configuration

#### Step 4: Configure Backend Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in real values:

```bash
cp backend/.env.example backend/.env
```

Open `backend/.env` and replace every placeholder with your actual credentials
(e.g. set `SCHOOL_WALLET_ADDRESS` to the public key generated in Step 2,
and set `JWT_SECRET` to a long random string).

> `backend/.env.example` contains only placeholder values — never real secrets.
> See the inline comments in that file for how to generate each value.

For the frontend, copy its example file as well:
```bash
cp frontend/.env.example frontend/.env.local
```

Edit `backend/.env` with your configuration:

```bash
# ── Required ────────────────────────────────────────────────
# MongoDB connection string
MONGO_URI=mongodb://localhost:27017/stellaredupay

# School's Stellar public key (from Step 2)
SCHOOL_WALLET_ADDRESS=G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE

# ── Stellar Network ──────────────────────────────────────────
# Use "testnet" for development, "mainnet" for production
STELLAR_NETWORK=testnet

# ── Server ───────────────────────────────────────────────────
PORT=5000

# ── Payment Limits (Optional) ─────────────────────────────────
# Minimum payment amount in XLM/USDC
MIN_PAYMENT_AMOUNT=0.01

# Maximum payment amount in XLM/USDC
MAX_PAYMENT_AMOUNT=100000

# ── Background Jobs (Optional) ────────────────────────────────
# How often to poll for new payments (milliseconds)
POLL_INTERVAL_MS=30000

# How often to retry failed verifications (milliseconds)
RETRY_INTERVAL_MS=60000

# Maximum retry attempts before giving up
RETRY_MAX_ATTEMPTS=10
```

#### Step 5: Configure Frontend Environment Variables

Create a `.env.local` file in the `frontend/` directory:

```bash
cd ../frontend
cp .env.local.example .env.local
```

Edit `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:5000/api
```

### Running the Application

#### Option A: Run Locally (Development)

**Terminal 1 - Start MongoDB** (if running locally):
```bash
mongod --dbpath /path/to/your/data/directory
```

**Terminal 2 - Start Backend**:
```bash
cd backend
npm run dev
```

You should see:
```
MongoDB connected
Server running on port 5000
Background polling started (interval: 30000ms)
Retry worker started (interval: 60000ms)
```

**Terminal 3 - Start Frontend**:
```bash
cd frontend
npm run dev
```

Visit **http://localhost:3000** in your browser.

#### Option B: Run with Docker Compose

```bash
# From the project root — replace the value with your actual public key
# MongoDB credentials are set via environment variables (defaults: root/password)
SCHOOL_WALLET_ADDRESS=G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE docker compose up --build
```

To use custom MongoDB credentials, set them before running:

```bash
export MONGO_ROOT_USERNAME=myuser
export MONGO_ROOT_PASSWORD=mysecurepassword
export SCHOOL_WALLET_ADDRESS=G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE
docker compose up --build
```

> On older Docker installations, use `docker-compose` (with a hyphen) instead of `docker compose`.

This will start:
- MongoDB on port 27017 (with authentication enabled)
- Backend on port 5000
- Frontend on port 3000

For Kubernetes, a sample readiness probe is available in `deploy/k8s/backend-deployment.yaml`. It polls `/health` on port 5000 with a 30 second startup delay so traffic is only routed after the backend and MongoDB are ready.

**Security Note**: MongoDB is configured with root authentication. The default credentials (root/password) should be changed in production. Generate secure passwords with:

```bash
openssl rand -base64 32
```

**Memory Limits**: The Docker Compose configuration includes memory limits to prevent OOM (out-of-memory) kills:

| Service | Default Limit | Purpose |
|---------|---------------|---------|
| Backend | 512 MB | Node.js process with `--max-old-space-size=400` |
| Frontend | 256 MB | Next.js build and runtime |
| Redis | 128 MB | In-memory cache |
| MongoDB | 1 GB | Database with indexes |

To customize memory allocation, set environment variables before running:

```bash
export BACKEND_MEM_LIMIT=1g
export FRONTEND_MEM_LIMIT=512m
export REDIS_MEM_LIMIT=256m
export MONGO_MEM_LIMIT=2g
docker compose up --build
```

The backend includes heap monitoring that logs warnings when memory usage exceeds 80% of the configured limit. Check logs for `HEAP_USAGE_WARNING` to detect memory leaks early.

### Initial Setup: Seed Data

Once the application is running, seed some initial data:

#### Using the Seed Script (Recommended)

The seed script populates the database with sample fee structures and students for local development and testing.

**Normal run (upsert — safe to re-run):**
```bash
node scripts/seed-test-data.js
```
Re-running this command is safe: all inserts use upsert, so no duplicate records are created.

**Clean run (drop and recreate):**
```bash
node scripts/seed-test-data.js --clean
```
Use `--clean` when you want a completely fresh dataset — it drops all seeded collections before re-seeding. Useful after schema changes or when you want to reset to a known state.

| Option | Behaviour | When to use |
|--------|-----------|-------------|
| _(none)_ | Upsert — creates or updates records | Day-to-day development, CI |
| `--clean` | Drop collections then re-seed | Schema changes, full reset |

#### Manual curl commands
```bash
curl -X POST http://localhost:5000/api/fees \
  -H "Content-Type: application/json" \
  -d '{
    "className": "Grade 5A",
    "feeAmount": 250,
    "description": "Annual tuition fees",
    "academicYear": "2026"
  }'
```

**2. Register a student:**
```bash
curl -X POST http://localhost:5000/api/students \
  -H "Content-Type: application/json" \
  -d '{
    "studentId": "STU001",
    "name": "Alice Johnson",
    "class": "Grade 5A"
  }'
```

The student's fee will be automatically assigned from the class fee structure.

**3. Get payment instructions:**
```bash
curl http://localhost:5000/api/payments/instructions/STU001
```

Response:
```json
{
  "walletAddress": "G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE",
  "memo": "STU001",
  "acceptedAssets": [
    { "code": "XLM", "type": "native", "displayName": "Stellar Lumens" },
    { "code": "USDC", "type": "credit_alphanum4", "displayName": "USD Coin" }
  ],
  "paymentLimits": {
    "min": 0.01,
    "max": 100000
  },
  "note": "Include the student ID exactly as the memo when sending payment."
}
```

**4. Make a test payment:**

Use a Stellar wallet (e.g., [Stellar Laboratory](https://laboratory.stellar.org/#txbuilder?network=test)) to send XLM to the school wallet address with memo `STU001`.

**5. Sync payments:**
```bash
curl -X POST http://localhost:5000/api/payments/sync
```

The backend will fetch recent transactions from the Stellar network and automatically match them to students.

---

## 🔐 Environment Variables

### Backend Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGO_URI` | ✅ Yes | - | MongoDB connection string (e.g., `mongodb://localhost:27017/stellaredupay`) |
| `SCHOOL_WALLET_ADDRESS` | ✅ Yes | - | School's Stellar public key (starts with `G...`) |
| `STELLAR_NETWORK` | ✅ Yes | `testnet` | Stellar network: `testnet` or `mainnet` |
| `PORT` | No | `5000` | Backend server port |
| `HORIZON_URL` | No | Auto | Stellar Horizon API URL (auto-detected from network) |
| `USDC_ISSUER` | No | Auto | USDC issuer address (auto-detected from network) |
| `MIN_PAYMENT_AMOUNT` | No | `0.01` | Minimum payment amount in XLM/USDC |
| `MAX_PAYMENT_AMOUNT` | No | `100000` | Maximum payment amount in XLM/USDC |
| `POLL_INTERVAL_MS` | No | `30000` | Background polling interval (milliseconds) |
| `RETRY_INTERVAL_MS` | No | `60000` | Retry worker interval (milliseconds) |
| `RETRY_MAX_ATTEMPTS` | No | `10` | Maximum retry attempts for failed verifications |
| `REDIS_HOST` | No | - | Redis hostname. When set, rate-limit counters are stored in Redis and survive server restarts. Without this, counters are in-process only and reset on restart (see note below). |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | - | Redis password (if required) |

> **Rate limit persistence**: When `REDIS_HOST` is configured, rate-limit counters persist across server restarts and are shared across multiple instances. Without Redis, counters are stored in-process — a restart resets all counters, allowing a previously rate-limited client to make requests immediately after restart. This is a known limitation acceptable for single-process or development deployments.

### Frontend Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | ✅ Yes | - | Backend API base URL (e.g., `http://localhost:5000/api`) |

### Configuration Validation

The application validates configuration on startup:
- `MIN_PAYMENT_AMOUNT` must be positive (> 0)
- `MAX_PAYMENT_AMOUNT` must be greater than `MIN_PAYMENT_AMOUNT`
- `SCHOOL_WALLET_ADDRESS` must be a valid Stellar public key

If validation fails, the application will not start and will display a clear error message.

---

## 📡 API Usage Examples

### Students

#### Register a Student
```bash
POST /api/students
Content-Type: application/json

{
  "studentId": "STU001",
  "name": "Alice Johnson",
  "class": "Grade 5A"
}
```

Response `201`:
```json
{
  "studentId": "STU001",
  "name": "Alice Johnson",
  "class": "Grade 5A",
  "feeAmount": 250,
  "feePaid": false
}
```

#### Get All Students
```bash
GET /api/students
```

#### Get a Specific Student
```bash
GET /api/students/STU001
```

### Fee Structures

#### Create a Fee Structure
```bash
POST /api/fees
Content-Type: application/json

{
  "className": "Grade 5A",
  "feeAmount": 250,
  "description": "Annual tuition fees",
  "academicYear": "2026"
}
```

#### Get All Fee Structures
```bash
GET /api/fees
```

#### Get Fee for a Class
```bash
GET /api/fees/Grade%205A
```

### Payments

#### Get Payment Instructions
```bash
GET /api/payments/instructions/STU001
```

Response `200`:
```json
{
  "walletAddress": "G_EXAMPLE_SCHOOL_WALLET_ADDRESS_HERE",
  "memo": "STU001",
  "acceptedAssets": [
    {
      "code": "XLM",
      "type": "native",
      "displayName": "Stellar Lumens"
    },
    {
      "code": "USDC",
      "type": "credit_alphanum4",
      "displayName": "USD Coin"
    }
  ],
  "paymentLimits": {
    "min": 0.01,
    "max": 100000
  },
  "note": "Include the student ID exactly as the memo when sending payment."
}
```

#### Verify a Transaction
```bash
POST /api/payments/verify
Content-Type: application/json

{
  "txHash": "abc123def456..."
}
```

Response `200`:
```json
{
  "hash": "abc123def456...",
  "memo": "STU001",
  "amount": 250,
  "feeAmount": 250,
  "feeValidation": {
    "status": "valid",
    "message": "Payment matches the required fee"
  },
  "date": "2026-03-24T10:00:00Z"
}
```

**Fee Validation Statuses:**
- `valid`: Payment exactly matches the required fee
- `overpaid`: Payment exceeds the required fee (still accepted)
- `underpaid`: Payment is less than required (not accepted)
- `unknown`: Student not found or memo missing

#### Sync Payments from Blockchain
```bash
POST /api/payments/sync
```

Fetches the 20 most recent transactions to the school wallet, matches memos to students, validates amounts, and records new payments.

Response `200`:
```json
{
  "message": "Sync complete"
}
```

#### Get Payment History for a Student
```bash
GET /api/payments/STU001
```

Response `200`:
```json
[
  {
    "txHash": "abc123...",
    "amount": 250,
    "feeAmount": 250,
    "feeValidationStatus": "valid",
    "memo": "STU001",
    "confirmedAt": "2026-03-24T10:00:00Z"
  }
]
```

#### Get Accepted Assets
```bash
GET /api/payments/accepted-assets
```

Response `200`:
```json
[
  {
    "code": "XLM",
    "type": "native",
    "displayName": "Stellar Lumens"
  },
  {
    "code": "USDC",
    "type": "credit_alphanum4",
    "displayName": "USD Coin"
  }
]
```

#### Get Payment Limits
```bash
GET /api/payments/limits
```

Response `200`:
```json
{
  "min": 0.01,
  "max": 100000,
  "message": "Payment amounts must be between 0.01 and 100000"
}
```

### Error Responses

All errors follow a consistent format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

**Common Error Codes:**
- `NOT_FOUND`: Resource not found (404)
- `VALIDATION_ERROR`: Invalid request data (400)
- `DUPLICATE_TX`: Transaction already recorded (409)
- `TX_FAILED`: Transaction failed on Stellar network (400)
- `MISSING_MEMO`: Transaction missing required memo field (400)
- `INVALID_DESTINATION`: Transaction sent to wrong wallet (400)
- `UNSUPPORTED_ASSET`: Payment made in unsupported asset (400)
- `AMOUNT_TOO_LOW`: Payment below minimum limit (400)
- `AMOUNT_TOO_HIGH`: Payment exceeds maximum limit (400)
- `STELLAR_NETWORK_ERROR`: Stellar Horizon API unavailable (502)

---

## 🧪 Testing

StellarEduPay includes comprehensive test coverage for all core functionality.

### Run All Tests

Tests mock both the Stellar SDK and MongoDB — no real network or database required.

```bash
# From the project root — install root dependencies first if you haven't already
npm install

npm test
```

Expected output:

```
PASS tests/stellar.test.js
PASS tests/payment.test.js
PASS tests/payment-limits.test.js

Test Suites: 3 passed, 3 total
Tests:       45 passed, 45 total
Snapshots:   0 total
Time:        5.234s
```

### Test Files

| Test File | Coverage |
|-----------|----------|
| [`tests/stellar.test.js`](tests/stellar.test.js) | Stellar service: asset detection, fee validation, amount normalization, transaction verification, ledger sync |
| [`tests/payment.test.js`](tests/payment.test.js) | Payment API: full payment flow, all endpoints, edge cases, error handling |
| [`tests/payment-limits.test.js`](tests/payment-limits.test.js) | Payment limits: validation, boundary cases, error codes |

### Run Specific Tests

```bash
# Test Stellar service only
npm test tests/stellar.test.js

# Test payment API only
npm test tests/payment.test.js

# Test payment limits only
npm test tests/payment-limits.test.js
```

### Test Coverage

All tests use mocks for:
- **Stellar SDK**: No real blockchain network calls
- **MongoDB**: In-memory database for isolation
- **HTTP requests**: Supertest for API testing

This ensures tests run quickly and don't require external dependencies.

---

## 📁 Project Structure

```
StellarEduPay/
├── backend/                          # Backend Node.js application
│   ├── src/
│   │   ├── app.js                    # Express server setup
│   │   ├── config/
│   │   │   ├── index.js              # Environment configuration
│   │   │   └── stellarConfig.js      # Stellar network configuration
│   │   ├── controllers/
│   │   │   ├── feeController.js      # Fee structure endpoints
│   │   │   ├── paymentController.js  # Payment endpoints
│   │   │   ├── reportController.js   # Report generation
│   │   │   └── studentController.js  # Student CRUD endpoints
│   │   ├── middleware/
│   │   │   └── validate.js           # Request validation middleware
│   │   ├── models/
│   │   │   ├── feeStructureModel.js  # Fee structure schema
│   │   │   ├── paymentModel.js       # Payment schema
│   │   │   ├── paymentIntentModel.js # Payment intent schema
│   │   │   ├── pendingVerificationModel.js # Retry queue schema
│   │   │   └── studentModel.js       # Student schema
│   │   ├── routes/
│   │   │   ├── feeRoutes.js          # Fee structure routes
│   │   │   ├── paymentRoutes.js      # Payment routes
│   │   │   ├── reportRoutes.js       # Report routes
│   │   │   └── studentRoutes.js      # Student routes
│   │   ├── services/
│   │   │   ├── reportService.js      # Report generation logic
│   │   │   ├── retryService.js       # Automatic retry mechanism
│   │   │   ├── stellarService.js     # Stellar blockchain integration
│   │   │   └── transactionService.js # Background polling
│   │   └── utils/
│   │       └── paymentLimits.js      # Payment limit validation
│   ├── .env.example                  # Example environment variables
│   └── package.json                  # Backend dependencies
│
├── frontend/                         # Next.js frontend application
│   ├── src/
│   │   ├── components/
│   │   │   ├── Navbar.jsx            # Navigation component
│   │   │   ├── PaymentForm.jsx       # Payment form component
│   │   │   ├── ReportDownload.jsx    # Report download component
│   │   │   └── TransactionCard.jsx   # Transaction display component
│   │   ├── pages/
│   │   │   ├── index.jsx             # Home page
│   │   │   ├── dashboard.jsx         # Student dashboard
│   │   │   ├── pay-fees.jsx          # Payment page
│   │   │   └── reports.jsx           # Reports page
│   │   ├── services/
│   │   │   └── api.js                # API client
│   │   └── styles/
│   │       └── globals.css           # Global styles
│   ├── .env.example                  # Example environment variables
│   └── package.json                  # Frontend dependencies
│
├── docs/                             # Documentation
│   ├── api-spec.md                   # Full API reference
│   ├── architecture.md               # System architecture
│   ├── payment-limits.md             # Payment limits documentation
│   └── stellar-integration.md        # Stellar integration details
│
├── scripts/
│   └── create-school-wallet.js       # Wallet generation script
│
├── tests/                            # Test suite
│   ├── payment.test.js               # Payment API tests
│   ├── payment-limits.test.js        # Payment limits tests
│   └── stellar.test.js               # Stellar service tests
│
├── .gitignore                        # Git ignore rules
├── CONTRIBUTING.md                   # Contribution guidelines
├── docker-compose.yml                # Docker Compose configuration
├── package.json                      # Root package.json for tests
└── README.md                         # This file
```

---

## 📚 Documentation

Comprehensive documentation is available in the [`docs/`](docs/) directory:

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | System design, component overview, data flow diagrams |
| [`docs/api-spec.md`](docs/api-spec.md) | Complete API reference with request/response examples |
| [`docs/stellar-integration.md`](docs/stellar-integration.md) | Stellar-specific details: memo field, assets, testnet setup |
| [`docs/payment-limits.md`](docs/payment-limits.md) | Payment limits feature: configuration, security, troubleshooting |

---

## 📋 Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for a complete history of changes, breaking changes, and migration guides.

---

## 📊 Monitoring & Observability

### Log Format

The backend emits **JSON-structured logs** to stdout. Each log line is a single JSON object:

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

Aggregate logs with any standard tool (CloudWatch Logs, Datadog, Loki, ELK). Filter by `level: "error"` for alerting.

### Health Check Endpoint

```
GET /health
```

| Response | Meaning |
|----------|---------|
| `200 { "status": "ok" }` | All systems healthy — MongoDB connected, background workers running |
| `200 { "status": "degraded", "details": {...} }` | App is up but a subsystem (e.g. Stellar Horizon) is unreachable; payments may be delayed |
| `503 { "status": "unhealthy" }` | MongoDB disconnected or a critical worker has crashed; the app cannot process payments |

Use the health endpoint as the target for load-balancer health checks and uptime monitors (e.g. UptimeRobot, AWS Route 53 health checks).

### Key Metrics to Monitor

| Metric | Description | How to Observe |
|--------|-------------|----------------|
| **Sync lag** | Time since the last successful blockchain sync | Log field `lastSyncAt`; alert if `now - lastSyncAt > 5 min` |
| **Retry queue depth** | Number of payments awaiting re-verification | Query `db.pendingverifications.countDocuments()` or expose via `/api/payments/retry-queue` |
| **Payment processing time** | Latency from transaction confirmed on Stellar to status updated in DB | Log field `processingMs` on each sync event |
| **Error rate** | Count of `level: "error"` log lines per minute | Log aggregation filter |
| **Underpaid / suspicious payments** | Payments flagged `feeValidationStatus: "underpaid"` or `isSuspicious: true` | MongoDB query or log filter |

### Recommended Alerting Thresholds

| Alert | Threshold | Severity |
|-------|-----------|----------|
| Sync lag | `lastSyncAt` older than **5 minutes** | Warning |
| Sync lag | `lastSyncAt` older than **15 minutes** | Critical |
| Retry queue depth | > **50** pending verifications | Warning |
| Retry queue depth | > **200** pending verifications | Critical |
| Payment processing time (p95) | > **10 seconds** | Warning |
| Health check | Returns `503` for **2 consecutive checks** | Critical |
| Error log rate | > **10 errors/minute** | Warning |

### Docker Compose Logs

```bash
# Stream all service logs
docker compose logs -f

# Backend only
docker compose logs -f backend

# Filter for errors
docker compose logs backend | grep '"level":"error"'
```

---

## 🤝 Contributing

We welcome contributions! Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on:

- Code of conduct
- Development workflow
- Pull request process
- Coding standards

> **CI requirement**: All pull requests must pass the CI workflow before merging. The CI runs the full test suite on every push and pull request targeting `main`.

### Quick Start for Contributors

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes and add tests
4. Run tests: `npm test`
5. Commit your changes: `git commit -m 'Add amazing feature'`
6. Push to the branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

---

## 🔮 Future Enhancements

- **Multi-School Support**: Isolated wallets and records per institution
- **Email/SMS Notifications**: Alert parents when payments are confirmed
- **Scholarship Disbursement**: Outbound XLM payments to student wallets
- **Hostel & Exam Fees**: Separate fee categories per student
- **Donation Tracking**: Transparent fund collection for school projects
- **Mobile App**: Native iOS/Android applications
- **Admin Dashboard**: Enhanced analytics and reporting
- **Recurring Payments**: Automatic payment scheduling
- **Multi-Currency Support**: Additional stablecoins (EURC, etc.)

---

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

## 🆘 Support

If you encounter any issues or have questions:

1. Check the [Documentation](docs/)
2. Search [existing issues](https://github.com/yourusername/StellarEduPay/issues)
3. Open a [new issue](https://github.com/yourusername/StellarEduPay/issues/new) with:
   - Clear description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, etc.)

---

## 🙏 Acknowledgments

- [Stellar Development Foundation](https://stellar.org) for the blockchain infrastructure
- [MongoDB](https://www.mongodb.com) for the database platform
- [Next.js](https://nextjs.org) for the frontend framework
- All contributors who help improve this project

---

## 🌐 Useful Links

- **Stellar Network**: https://stellar.org
- **Stellar Laboratory**: https://laboratory.stellar.org
- **Stellar Horizon API**: https://developers.stellar.org/api
- **Stellar Explorer (Testnet)**: https://stellar.expert/explorer/testnet
- **Stellar Explorer (Mainnet)**: https://stellar.expert/explorer/public
- **MongoDB Atlas**: https://www.mongodb.com/atlas

---
## 🛠 Troubleshooting & Pitfalls

If you encounter issues during setup, check the table below for common Stellar-specific errors and their solutions.

| Error | Likely Cause | Solution |
| :--- | :--- | :--- |
| `tx_insufficient_balance` | The Stellar account in your `.env` has 0 XLM. | Go to the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=testnet) and use **Friendbot** to fund your Secret Key. |
| `op_no_trust` | The recipient hasn't established a trustline for your custom asset. | Ensure the `ChangeTrust` operation is submitted by the student/user account before attempting to send tokens. |
| `connection refused` | The MongoDB container is down or the URI is incorrect. | Run `docker ps` to ensure the `mongo` container is healthy. If running the backend natively, ensure `MONGO_URI` points to `localhost:27017`. |
| `tx_bad_auth` | The `STELLAR_SECRET_KEY` does not match the public address being used. | Double-check your `.env` file to ensure the Secret Key corresponds to the correct Public Key. |

### 🔍 Viewing Logs
If the containers are running but the API isn't responding, check the real-time logs:
```bash
docker-compose logs -f backend

---

**Built with ❤️ using Stellar blockchain technology**
