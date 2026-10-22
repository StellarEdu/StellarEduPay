# Payment Plans & Underpaid Reconciliation

## Overview

Two subsystems disagree about what a "short" payment means.

This document defines the **canonical student balance formula** used across all
payment pipelines in StellarEduPay and explains how partial (installment) payments
are reconciled, how credit adjustments are applied, and how the system determines
whether a student has paid in full.

---

## The Canonical Balance Formula

> Fix #1751 — prior to this change six code paths each computed the balance
> independently with different filters, causing dashboards, reminders, receipts,
> and reports to disagree on a student's paid/remaining amounts.

**The single source of truth is `backend/src/utils/studentBalanceUpdater.js`.**
Every pipeline that records a payment **must** call `updateStudentBalance(schoolId,
studentId, { session })` after persisting the payment record, and **must not** write
`Student.totalPaid`, `Student.remainingBalance`, or `Student.feePaid` directly.

### What the running code does

Partial payments are **accepted and recorded as `SUCCESS`** — funds have
already arrived on-chain. The `Payment.feeValidationStatus` field records
`partial` for any payment below the total fee, including plan installments.
This field describes the payment against the total fee and is what the balance,
receipt, and reporting code reads.

The `Payment` model carries an `underpaidReconciliation` sub-document
(`status`, `appliedCredit`, `creditAppliedAt`, `creditAppliedBy`,
`refundTxHash`, `refundInitiatedAt`, `refundCompletedAt`, `refundNote`) that
is populated by the refund service when a refund is processed.

A plan holder's installment is credited immediately toward the student's
cumulative balance; the remaining shortfall is reflected in the student's
`remainingBalance`.

### Formula

```
totalPaid = (Σ payment.amount where ALL conditions below hold)
            + creditAdjustments

Conditions:
  payment.status      === 'SUCCESS'   // on-chain confirmed; excludes PENDING,
                                      //   FAILED, SUBMITTED, and REFUNDED
  payment.isSuspicious === false      // not under fraud review
  payment.deletedAt    === null       // not soft-deleted
  payment.schoolId     === <schoolId> // tenant isolation
  payment.studentId    === <studentId>

remainingBalance = max(0, student.feeAmount - totalPaid)
feePaid          = totalPaid >= student.feeAmount
```

Arithmetic is performed in **exact Decimal128 space** inside MongoDB (`$toDecimal`
accumulator) to eliminate floating-point drift across many installments.

---

## Why Each Condition Matters

| Condition | Consequence of omitting it |
|-----------|---------------------------|
| `status === 'SUCCESS'` | PENDING, FAILED, and REFUNDED payments count as paid. A family whose payment was refunded stops receiving reminders and shows as "paid" on the dashboard. |
| `isSuspicious === false` | A suspicious payment under fraud review counts toward the balance, showing the student as (partially) paid while the money is held. |
| `deletedAt === null` | Soft-deleted payment records continue to inflate the balance. |
| `+ creditAdjustments` | Admin-applied manual credits (e.g. scholarship, hardship waiver) are silently wiped on the next balance rewrite if they are not added here. |

---

## The `feeValidationStatus` vocabulary

`Payment.feeValidationStatus` is one of `valid`, `partial`, `underpaid`,
`overpaid`, `unknown`. The two "short" values have distinct, fixed meanings:

| Value | Meaning |
|---|---|
| `partial` | The student's cumulative total is below `Student.feeAmount`. This is the normal state of every installment on a payment plan, and of any accepted part-payment. |
| `underpaid` | A payment below the expected **installment** amount where an active plan exists (the #1379 semantics). Only `evaluateUnderpayment` may assign it. |
| `valid` | Cumulative total equals the fee (or the installment, for a plan holder). |
| `overpaid` | Cumulative total exceeds the fee. |
| `unknown` | The payment could not be classified (e.g. missing fee or amount). |

`partial` is never a synonym for `underpaid`. A plan holder's installment is
`partial` against the total fee and `valid` against its installment; it is
`underpaid` only when it falls short of the installment it is paying.

### One classifier

`classifyFeePayment` (`backend/src/utils/money.js`) is the only function that
assigns `feeValidationStatus`. Every writer — the verify path,
`updateStudentBalance`, `stellarService.syncPaymentsForSchool`,
`transactionPollingService.processTransaction` (poller and stream), and any
future caller — must route through it (directly, or via
`evaluateUnderpayment` for the installment case). Writers must not hard-code
`'partial'` or `'underpaid'`; doing so is what made reports, dashboards and
rollups undercount part-payments.

### Readers

Report and rollup aggregations bucket `valid`, `partial`, `underpaid`,
`overpaid` and `unknown` separately, and the buckets must sum to
`paymentCount`. The underpaid reconciliation queue and the UI's "underpaid"
filters read `underpaid` only; "partial" filters read `partial`.

### Migrating historical rows

Rows written before this vocabulary was unified may carry `underpaid` where
`partial` is meant (poller/stream) or `partial` where `underpaid` is meant
(plan installments below their installment amount). Migration re-derives the
value with `classifyFeePayment` / `evaluateUnderpayment` from the stored
amounts rather than guessing from the old string.

## Report totals are per asset

`Payment.assetCode` is one of `stellarConfig.ACCEPTED_ASSETS` (`XLM`,
`USDC`). Amounts in different assets are never added together. Every
aggregation in `reportService` (daily reports, per-class totals, the dashboard,
analytics, metrics rollups and the reconciliation report) groups by
`assetCode` and returns:

- `totals: { XLM: '<exact string>', USDC: '<exact string>' }` — one entry per
  asset present, as exact decimal strings;
- `totalFiat` — the sum of `fiatSnapshot` values, in the reporting currency;
- `fiatCoverage` — the percentage of payments that carry a `fiatSnapshot`, so
  a `totalFiat` computed from partial coverage is visibly incomplete.

The CSV export emits one row per asset and carries a bumped `schemaVersion`;
integrators must read `totals` per asset instead of a single `Total Amount`
column.

## What this deliberately does not change

`evaluateUnderpayment` is the only sanctioned entry point for the installment
question, and `classifyFeePayment` the only sanctioned entry point for the
cumulative one. A new caller that wants to know whether a payment is short
must go through one of them rather than comparing against `feeAmount` or an
installment amount directly, or the bug returns in that caller.

Covered by `tests/underpaidReconciliationPaymentPlans.test.js`, the report
bucket-sum tests, and the mixed-asset report fixtures.

---

## Per-Category Fee Breakdown

When a student has multiple fee categories (`student.fees[]`), `updateStudentBalance`
also recomputes each category's `totalPaid`, `remainingBalance`, and `paid` flag using
the same formula applied per category:

```
category.totalPaid       = Σ payment.amount
                           where  status === 'SUCCESS'
                                  AND isSuspicious === false
                                  AND deletedAt === null
                                  AND feeCategory === <category>
category.remainingBalance = max(0, category.amount - category.totalPaid)
category.paid             = category.totalPaid >= category.amount
```

Category breakdowns are used by the payment instructions endpoint, the student
detail view, and the per-category payment flow.

---

## Installment / Payment Plan Support

StellarEduPay accepts partial payments by design. A single on-chain payment below the
full fee is recorded with `feeValidationStatus: 'partial'` (or `'underpaid'` in the
poller path — these are per-payment labels for the UI only). The student's
**balance fields are recomputed from the full payment history** on every write, so
an installment plan that eventually reaches the exact fee amount will have
`feePaid: true` and `remainingBalance: 0` once the last installment is confirmed.

### Underpaid Flow

```
Payment A (100 of 300 fee)  → totalPaid=100, remainingBalance=200, feePaid=false
Payment B (150 of 300 fee)  → totalPaid=250, remainingBalance=50,  feePaid=false
Payment C (50  of 300 fee)  → totalPaid=300, remainingBalance=0,   feePaid=true
```

Reminders continue firing (subject to cooldown) while `remainingBalance > 0`.

### Overpaid Flow

```
Payment A (350 of 300 fee)  → totalPaid=350, remainingBalance=0, feePaid=true
                               excessAmount=50 stored on the payment record
```

The excess is stored per-payment for the overpayment report
(`GET /api/payments/overpayments`). It does **not** affect the stored
`remainingBalance` (which floors at 0).

---

## Credit Adjustments

Admin users can apply manual credit adjustments via
`POST /api/students/:id/credit-adjustments`. These are stored as
`student.creditAdjustments` (a single running total, in the same currency unit as
fees).

`updateStudentBalance` adds `creditAdjustments` to the aggregated payment total
**before** computing `remainingBalance`. This means:

- A partial waiver reduces the remaining balance without creating a on-chain payment.
- Subsequent payment pipeline runs do **not** overwrite the credit — it is always
  re-read from `student.creditAdjustments` and re-applied.

Prior to fix #1751 only the `studentBalanceUpdater` path included credits; the poller,
sync, finalizer, and reminder paths all overwrote the balance without them.

---

## Pipeline Integration

Every pipeline that records a payment follows this pattern:

```
┌──────────────────────────────────────────────────┐
│  1. Record the Payment document (status:SUCCESS)  │
│     inside a MongoDB session/transaction          │
├──────────────────────────────────────────────────┤
│  2. Call updateStudentBalance(schoolId,           │
│       studentId, { session })                     │
│     • reads all SUCCESS/non-suspicious payments   │
│     • adds creditAdjustments                      │
│     • writes Student.totalPaid /                  │
│       remainingBalance / feePaid atomically       │
├──────────────────────────────────────────────────┤
│  3. Commit the session                            │
└──────────────────────────────────────────────────┘
```

| Pipeline | File | Guard |
|----------|------|-------|
| Blockchain poller | `transactionPollingService.processTransaction` | `isConfirmed && !isSuspicious` |
| Manual sync | `stellarService.syncPaymentsForSchool` | `isConfirmed && !isSuspicious && !studentDeleted` |
| Confirmation finalizer | `stellarService.finalizeConfirmedPayments` | `isConfirmedOrAbove(nextState)` |
| Manual verify | `paymentController.verifyPayment` | always (payment is SUCCESS at this point) |
| XDR submit | `paymentController.submitTransaction` | always (payment is SUCCESS at this point) |

The reminders scheduler (`reminderService.processReminders`) does **not** record
payments; it **reads** `student.remainingBalance` (written by one of the pipelines
above) to decide whether to send a reminder.

---

## Consistency Check

The admin endpoint `GET /api/consistency` runs `consistencyService`, which re-applies
the canonical formula for every student and reports any student whose stored
`totalPaid` / `remainingBalance` diverges from the freshly computed value.

After a successful run of fix #1751 this endpoint should report zero drift for all
students. Drift can re-appear if:

- A payment's `status` or `isSuspicious` field is mutated directly in the database
  without calling `updateStudentBalance` afterward.
- A `creditAdjustments` update is applied to `Student` without a subsequent
  `updateStudentBalance` call.

In both cases the fix is to call `updateStudentBalance(schoolId, studentId, {})` for
the affected student, or to run the consistency-check's `--fix` flag if it exposes
one.

---

## See Also

- [`backend/src/utils/studentBalanceUpdater.js`](../backend/src/utils/studentBalanceUpdater.js) — canonical implementation
- [`backend/src/utils/money.js`](../backend/src/utils/money.js) — `classifyFeePayment`, `toMoney`, `decimalFromMongo`
- [`docs/architecture.md`](architecture.md) — overall system design
- [`docs/security.md`](security.md) — suspicious payment detection
- GitHub issue #1751 — original bug report and fix tracking
