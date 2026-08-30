# Payment Plans and Underpaid Reconciliation

Two subsystems disagree about what a "short" payment means, and issue #1379 is
the consequence of that disagreement.

## The two views of a partial payment

`classifyFeePayment` (`backend/src/utils/money.js`) compares a student's
cumulative total against `Student.feeAmount`. Anything below it is `partial`,
which is the correct reading for a student paying their fee in one go.

A student on a payment plan (`backend/src/models/paymentPlanModel.js`) pays a
schedule of installments instead. Every installment is below the total fee by
design, so the cumulative classification marks each one `partial` until the
final payment lands.

`underpaidReconciliationService` reads that `partial` flag and acts on it. It
applies credits and initiates refunds. Left alone it therefore refunds money a
parent deliberately paid, and notifies them about an underpayment they never
made.

## The rule

**Where a student has an active payment plan, a payment is judged against the
installment amount, not the total fee.**

`evaluateUnderpayment(payment)` in
`backend/src/services/underpaidReconciliationService.js` is the single place
that decision is made:

| Student state | Benchmark | `basis` |
|---|---|---|
| Active payment plan with installments | the next unpaid installment's `amount` | `installment` |
| Active plan whose installments are all settled | the final installment's `amount` | `installment` |
| No plan, or a `completed` / `cancelled` plan | `Student.feeAmount`, via the existing classification | `fee` |

A plan holder's payment is underpaid only when it falls below the installment
it is paying. A payment at or above that amount is intentional.

## Where the rule is enforced

- `getPendingUnderpaidPayments` filters covered installments out of the
  listing, so they never enter the reconciliation queue an operator works
  through.
- `applyPartialCredit` and `initiateRefund` both throw if the payment turns out
  to be a covered installment, so a direct call by ID cannot bypass the
  listing filter.

## What this deliberately does not change

- `Payment.feeValidationStatus` still records `partial` for an installment.
  That field describes the payment against the total fee, which remains true
  and is what the balance, receipt, and reporting code reads. Only the
  reconciliation workflow's interpretation of it changed.
- Plans in `completed` or `cancelled` state confer no exemption. Only `active`
  plans are consulted, so a cancelled plan cannot be used to dodge
  reconciliation of a genuinely short payment.

## When changing this

`evaluateUnderpayment` is the only sanctioned entry point. A new caller that
wants to know whether a payment is short must go through it rather than
comparing against `feeAmount` directly, or the bug returns in that caller.

Covered by `tests/underpaidReconciliationPaymentPlans.test.js`.
