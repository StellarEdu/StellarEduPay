# Testing syncPayments - Unmatched Memo Scenarios

## Overview

This document describes the test coverage for `syncPaymentsForSchool` function, specifically focusing on edge cases where transactions have unmatched memos or missing memos.

## Test Scenarios

### 1. Transaction with Unmatched Memo

**Scenario**: A transaction arrives with a memo that doesn't match any registered student or payment intent.

**Test**: `skips transaction with unmatched memo (no matching student)`

**Setup**:
- Transaction with memo: `UNKNOWN_STUDENT_999`
- No PaymentIntent exists for this memo
- No Student exists with this ID

**Expected Behavior**:
- Transaction is skipped (no error thrown)
- No Payment document is created
- No Student document is updated
- Function continues processing other transactions

**Real-world Example**:
```javascript
// Transaction on Stellar network
{
  hash: 'abc123...',
  memo: 'UNKNOWN_STUDENT_999',
  amount: 100 XLM,
  to: SCHOOL_WALLET
}

// Result: Silently skipped, no database changes
```

### 2. Transaction with No Memo Field

**Scenario**: A transaction arrives without a memo field (undefined).

**Test**: `skips transaction with no memo field`

**Setup**:
- Transaction with `memo: undefined`
- Valid payment operation to school wallet

**Expected Behavior**:
- Transaction is skipped without error
- No Payment document is created
- No Student document is updated
- Function continues gracefully

**Real-world Example**:
```javascript
// Transaction on Stellar network
{
  hash: 'def456...',
  memo: undefined,  // No memo provided
  amount: 100 XLM,
  to: SCHOOL_WALLET
}

// Result: Silently skipped, no database changes
```

### 3. Transaction with Empty String Memo

**Scenario**: A transaction arrives with a whitespace-only memo.

**Test**: `skips transaction with empty string memo`

**Setup**:
- Transaction with `memo: '   '` (whitespace only)
- Valid payment operation to school wallet

**Expected Behavior**:
- Transaction is skipped without error
- No Payment document is created
- No Student document is updated
- Function continues gracefully

**Real-world Example**:
```javascript
// Transaction on Stellar network
{
  hash: 'ghi789...',
  memo: '   ',  // Empty/whitespace memo
  amount: 100 XLM,
  to: SCHOOL_WALLET
}

// Result: Silently skipped, no database changes
```

## Why These Tests Matter

### 1. Real-World Scenarios

Parents may:
- Mistype the student ID in the memo field
- Send payments without reading instructions
- Use the wrong memo from a previous payment
- Forget to include the memo entirely

### 2. Data Integrity

Without proper handling:
- Orphaned payments could be created
- Student records could be incorrectly updated
- Payment reconciliation would fail
- Manual intervention would be required

### 3. System Stability

These tests ensure:
- No crashes from unexpected memo values
- Graceful degradation when data is missing
- Predictable behavior for edge cases
- Safe continuation of sync process

## Implementation Details

### extractValidPayment Function

The `extractValidPayment` function is the first line of defense:

```javascript
// Returns null for invalid transactions
if (!tx.successful) return null;
if (!tx.memo || !tx.memo.trim()) return null;  // Catches undefined and empty memos
```

### syncPaymentsForSchool Function

The sync function has multiple validation layers:

```javascript
// Layer 1: Extract valid payment (checks memo exists)
const valid = await extractValidPayment(tx, stellarAddress);
if (!valid) continue;  // Skip if no valid payment

// Layer 2: Find matching payment intent
const intent = await PaymentIntent.findOne({ schoolId, memo, status: 'pending' });
if (!intent) continue;  // Skip if no matching intent

// Layer 3: Find matching student
const student = await Student.findOne({ schoolId, studentId: intent.studentId });
if (!student) continue;  // Skip if student not found
```

Each layer acts as a filter, ensuring only valid, matched transactions are processed.

## Running the Tests

### Run All Tests

```bash
npm test
```

### Run Only Stellar Tests

```bash
npm test -- stellar.test.js
```

### Run Specific Test

```bash
npm test -- -t "skips transaction with unmatched memo"
```

### Run with Coverage

```bash
npm test -- --coverage
```

## Test Output

Expected output when tests pass:

```
PASS  tests/stellar.test.js
  syncPaymentsForSchool
    ✓ resolves without error when no transactions exist (5ms)
    ✓ skips transaction with unmatched memo (no matching student) (12ms)
    ✓ skips transaction with no memo field (8ms)
    ✓ skips transaction with empty string memo (7ms)
    ✓ stops pagination when a known txHash is encountered (15ms)
```

## Debugging Failed Tests

### If "skips transaction with unmatched memo" fails:

1. Check if `Payment.create` was called:
   ```javascript
   console.log('Payment.create calls:', Payment.create.mock.calls);
   ```

2. Check if `Student.findOneAndUpdate` was called:
   ```javascript
   console.log('Student updates:', Student.findOneAndUpdate.mock.calls);
   ```

3. Verify PaymentIntent mock returns null:
   ```javascript
   console.log('PaymentIntent.findOne result:', await PaymentIntent.findOne());
   ```

### If "skips transaction with no memo field" fails:

1. Check if `extractValidPayment` is filtering correctly:
   ```javascript
   const valid = await extractValidPayment(noMemoTx, stellarAddress);
   console.log('Valid payment result:', valid); // Should be null
   ```

2. Verify the transaction structure:
   ```javascript
   console.log('Transaction memo:', noMemoTx.memo); // Should be undefined
   ```

## Related Tests

These tests complement existing tests in `stellar.test.js`:

- `extractValidPayment` - Tests the validation layer
- `verifyTransaction` - Tests transaction verification
- `parseIncomingTransaction` - Tests transaction parsing
- `validatePaymentAgainstFee` - Tests fee validation

### 4. Transaction with Memo Matching a Soft-Deleted Student

**Scenario**: A transaction's memo (or a still-pending intent it resolves to)
identifies a student who has since been soft-deleted (`deletedAt` set).

**Test**: `records payment for memo matching a soft-deleted student instead of
dropping it (flagged for manual review)`

**Verified behavior**: The funds already left the payer's wallet, so the
payment is recorded with `studentDeleted: true` — the same flag used
elsewhere when an existing student (with prior payments) is deleted — instead
of being dropped into the generic unmatched-memo bucket. The (deleted)
student's stored balance is never mutated. The payment is visible via the
existing `getDeletedStudentPayments` audit endpoint for manual review, and is
excluded from active reports/balances by the existing `studentDeleted: { $ne:
true }` filters used throughout reporting and student-balance code.

### 5. Transaction with Memo Matching an Already-Completed Payment Intent

**Scenario**: A transaction's memo matches a `PaymentIntent` that has already
transitioned to `status: 'completed'` (e.g. a delayed or duplicate
submission arriving after the intent was already fully paid).

**Test**: `credits a transaction whose memo matches an already-completed
payment intent (intent-decoupled fallback match)`

**Verified behavior**: The `status: 'pending'` intent lookup finds nothing,
so the sync falls back to matching the student directly by `studentId` (the
intent-decoupled crediting path from #848). The transaction is credited to
the student as an additional payment (raising `totalPaid`, and marking the
payment `overpaid` if it exceeds the fee) rather than being dropped — funds
are never silently lost.

## Future Enhancements

Potential additional test scenarios:

1. Transaction with memo in wrong format (e.g., lowercase)
2. Transaction with memo containing special characters
3. Transaction with memo that's too long
4. Multiple transactions with same unmatched memo

## Acceptance Criteria

✅ Unmatched memo transactions do not create payment records
✅ No-memo transactions are skipped without error
✅ Empty/whitespace memo transactions are skipped without error
✅ Both cases are covered by passing tests
✅ No Student documents are updated for invalid transactions
✅ Sync process continues gracefully after encountering invalid transactions
✅ Memo-matches-deleted-student transactions are recorded (studentDeleted: true) for manual review, not dropped
✅ Memo-matches-completed-intent transactions are credited via the intent-decoupled fallback, not dropped
