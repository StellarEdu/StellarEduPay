# Runbook: School Wallet Address Rotation

**Component:** `School.stellarAddress`, `transactionPollingService`, `schoolController.rotateStellarAddress`
**Severity:** high — this is the account that receives every parent's fee payment for the school.
**Closes:** [#1387](https://github.com/StellarEdu/StellarEduPay/issues/1387)

---

## Overview

Each school has one Stellar wallet, `School.stellarAddress`, that
`transactionPollingService` monitors for incoming payments. The poller tracks
its position with `School.syncCursor` — a Horizon `paging_token` scoped to
*that specific address* — and resumes ascending paging from it every cycle
(see `transactionPollingService.js`).

Changing `stellarAddress` — because a school's wallet was compromised, or
because they simply want to rotate to a new custodian — has two failure modes
if done carelessly:

1. **Missed in-flight payments.** A parent who already sent a payment to the
   old address, but whose transaction hasn't confirmed yet (or who scanned an
   old QR code/shared link after the cutover), will have their payment land on
   an address nobody is polling anymore.
2. **A meaningless cursor.** `syncCursor` is a paging token into the *old*
   address's transaction history. Carrying it over to the new address is
   wrong (Horizon will reject or misinterpret it); starting from `null` is
   correct but means the poller has no memory of anything — it's a fresh
   start, not a migration.

This runbook — combined with `PUT /api/schools/:schoolId/stellar-address`
(step-up password + mandatory `reason`, `schoolController.rotateStellarAddress`)
and the `previousStellarAddress` + audit-log trail it writes — is the
supported way to rotate a school's wallet without silently losing payments.

---

## Pre-rotation checklist

Before calling the rotation endpoint:

- [ ] Confirm the new wallet address is controlled by the school (or your
      custodian) and is a valid Ed25519 Stellar public key.
- [ ] If rotating due to a **suspected compromise** of the old wallet's
      secret key, treat this as a security incident: rotating the receiving
      address does not revoke the compromised secret key's ability to move
      funds *already in* the old account. Coordinate moving any existing
      balance out of the old account separately.
- [ ] Decide and record the **reason** you'll pass to the endpoint (e.g.
      `"scheduled custodian migration"`, `"suspected key compromise —
      INC-1234"`) — this is required and becomes part of the permanent audit
      trail (`AuditLog.details.reason`, action `school_stellar_address_rotated`).
- [ ] Pick a **cutover window** (see below) and notify the school so parents
      mid-payment aren't left in limbo.
- [ ] Have Horizon access ready (`curl` or the Stellar Laboratory) to query
      the old address's recent transaction history for the drain step below.

## 1. Drain the old address

Query the old address for any transactions still arriving or unconfirmed
around the cutover time:

```bash
curl -s "https://horizon.stellar.org/accounts/<OLD_ADDRESS>/payments?order=desc&limit=20" | jq '.records[] | {id, created_at, from, amount}'
```

Cross-reference the results against `StellarEduPay`'s `Payment` records for
the school (`GET /api/students/:studentId/payments` per student, or a direct
`Payment.find({ schoolId })` query) to confirm every payment the pre-rotation
poller already saw is recorded. Any payment on Horizon that isn't yet in
`Payment` is still in flight — wait for it to confirm before rotating, or be
prepared to manually reconcile it afterward (see step 4).

If the rotation is due to a compromise and you cannot wait, proceed but flag
the gap explicitly in the reason and in the incident log — the post-rotation
verification step below is how you catch anything that landed during the
gap.

## 2. Cursor management during the transition

`rotateStellarAddress` always sets `syncCursor` to `null` when it updates
`stellarAddress` — the old cursor has no meaning against the new address's
history, and starting from `null` makes the poller walk the new address's
**entire** transaction history from genesis on the first cycle after
rotation. This is intentional: it guarantees nothing sent to the new address
before StellarEduPay started watching it (e.g. a test payment, or a payment
sent slightly before you called the endpoint) is missed.

Two things follow from this:

- The first poll cycle after rotation may take noticeably longer than usual
  for an address with existing history — this is expected, not a hang.
- The **old address keeps its own `previousStellarAddress` record** but is no
  longer polled at all once `stellarAddress` changes. Anything sent to it
  after the cutover will never be picked up automatically — this is why the
  drain step (above) and the parent-facing cutover window matter more than
  the cursor mechanics.

## 3. Perform the rotation

```bash
curl -X PUT "https://<api-host>/api/schools/<schoolId>/stellar-address" \
  -H "Authorization: Bearer <admin JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "stellarAddress": "<NEW_ADDRESS>",
    "reason": "scheduled custodian migration",
    "confirmPassword": "<ADMIN_PASSWORD>"
  }'
```

The endpoint:

- Requires `requireAdminAuth` (a valid admin session) **and** the step-up
  `confirmPassword` check against `ADMIN_PASSWORD` — the same two-factor
  requirement `updateSchool()` already applies to `stellarAddress` changes.
- Rejects the request with `400 REASON_REQUIRED` if `reason` is missing or
  blank.
- Rejects a no-op rotation (`newAddress === currentAddress`) with
  `400 STELLAR_ADDRESS_UNCHANGED`.
- Verifies the new account is funded on the Stellar network and returns
  `202` with a `warning` field (instead of `200`) if it isn't yet — the
  rotation still succeeds, but expect no payments to confirm until the new
  account is funded.
- Copies the current `stellarAddress` into `previousStellarAddress`, sets the
  new `stellarAddress`, and resets `syncCursor` to `null`.
- Writes an `AuditLog` entry: `action: 'school_stellar_address_rotated'`,
  `details: { previousStellarAddress, newStellarAddress, reason, severity: 'high' }`.
- Invalidates the school cache (`schoolCacheInvalidator`) so every replica
  picks up the new address within seconds, not the cache's normal TTL.

## 4. Post-rotation verification

- Confirm the response body shows the expected `stellarAddress` and
  `previousStellarAddress`.
- Query the audit trail for the rotation entry and confirm the `reason` and
  `performedBy` are correct:
  ```bash
  curl -s "https://<api-host>/api/audit-logs?schoolId=<schoolId>&action=school_stellar_address_rotated" \
    -H "Authorization: Bearer <admin JWT>" | jq '.[0]'
  ```
- Watch the backend logs for the next `transactionPollingService` cycle for
  this school and confirm it's now polling the new address:
  ```bash
  docker compose logs --tail=200 backend | grep -i "<schoolId>"
  ```
- Send (or ask the school to confirm) a small test payment to the new
  address and verify it appears in `GET /api/students/:studentId/payments`
  within one poll cycle.
- If the drain step found any unresolved in-flight payment to the **old**
  address, manually reconcile it: the payment recording pipeline keys off
  `txHash` and `schoolId`, not the receiving address, so it can be recorded
  through the normal manual/CSV import path (`docs/architecture.md`) once
  confirmed on Horizon.
- Update the school's off-platform records (wallet custodian docs,
  onboarding notes) with the new address — `previousStellarAddress` is for
  audit/reconciliation only and is not surfaced to parents.

---

## Related Documents

- Signing-key secrets management: [`docs/security.md`](../security.md#signer-master-key-secrets-management-1386)
- Poller implementation: [`backend/src/services/transactionPollingService.js`](../../backend/src/services/transactionPollingService.js)
- Rotation endpoint: [`backend/src/controllers/schoolController.js`](../../backend/src/controllers/schoolController.js) (`rotateStellarAddress`)
- School model fields: [`backend/src/models/schoolModel.js`](../../backend/src/models/schoolModel.js)
