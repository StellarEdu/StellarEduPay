# Parent self-service portal

> Closes #1637

Parents can see what they owe, what they have paid, download receipts, follow
an active payment plan, report a problem with a payment and switch reminder
emails on or off, with no staff account and without the school's help.

## Access model: per-family magic links

- A school issues a **magic link**: `${APP_URL}/parent?token=<token>`.
- The token is a JWT signed with a key **derived from** `JWT_SECRET`
  (`HMAC(JWT_SECRET, "stellaredupay:parent-portal:v1")`), with
  `aud: parent-portal`, `typ: parent`, the school (`sid`) and a random `jti`.
  Staff tokens are not accepted as parent tokens, and parent tokens are not
  accepted as staff tokens.
- Every token has a `ParentAccessToken` record (`schoolId`, `tokenId`,
  SHA-256 of the token, `studentIds`, `expiresAt`, `revokedAt`, usage stats).
  **The record decides access**: the token only works while its record exists,
  is not revoked and has not expired, and only for the `studentIds` it lists, in
  that one school.
- Lifetime: `PARENT_PORTAL_TOKEN_TTL_DAYS` (default 30, max 180), or
  `ttlDays` per link.
- Records are purged automatically 30 days after they expire (TTL index).

### Privacy

- Nothing is visible without a valid token. Requests for a student, payment
  or receipt outside the link's scope return **404**, so a link cannot be used
  to find out whether other student IDs or transactions exist.
- The API accepts the token **only** in the `X-Parent-Token` header (or
  `Authorization: Parent <token>`), never as a query parameter. The `/parent`
  page reads `?token=` once, moves it to `sessionStorage` and removes it from
  the address bar, and sets `Referrer-Policy: no-referrer` and `noindex`.
- `/api/parent/*` responses are `Cache-Control: no-store`.
- Parent requests are rate-limited per IP (`PARENT_PORTAL_RATE_LIMIT`/min,
  default 60) and writes to 10 per 15 min.
- Every parent action is audit-logged (`parent_portal_view`,
  `parent_portal_receipt`, `parent_portal_dispute`,
  `parent_portal_preferences`) with `performedBy: parent:<tokenId>`, as are
  link issuance and revocation.

## Issuing links

### By staff (owner / staff)

```http
POST /api/parent/links
X-School-ID: SCH-001
Authorization: Bearer <staff token>

{ "studentIds": ["STU-1", "STU-2"], "ttlDays": 30, "send": true }
```

or, for every student whose `parentEmail` matches (blind-index lookup):

```json
{ "parentEmail": "parent@example.com", "send": true }
```

Response `201`: `{ tokenId, url, expiresAt, studentIds, emailed }`. With
`send: true` the link is emailed to the parent. The URL is only returned once —
it is not stored and cannot be retrieved later.

### In reminder emails

Set `PARENT_PORTAL_EMAIL_LINKS=true` to add a portal link to every fee
reminder. Each email gets its own link for that student, valid for
`PARENT_PORTAL_EMAIL_LINK_TTL_DAYS` (default 14). If issuing fails the email
still goes out without the link.

## Revoking links

| Endpoint | Effect |
|----------|--------|
| `DELETE /api/parent/links/:tokenId` (`{ reason? }`) | Revoke one link. |
| `POST /api/parent/links/revoke-student/:studentId` (`{ reason? }`) | Revoke every active link that includes the student (e.g. custody change). |
| `GET /api/parent/links?studentId=&includeInactive=true` | List links with creator, expiry, revocation and last use (owner / staff / read_only). |

Revocation takes effect on the next request.

## Parent API

All parent endpoints need `X-Parent-Token`.

| Endpoint | Returns |
|----------|---------|
| `GET /api/parent/me` | School branding / support contact, link expiry, and for each linked student: fees, total paid, outstanding balance, deadline, per-category fees, active payment plan (progress + next installment) and reminder preference. |
| `GET /api/parent/students/:studentId/payments?page=&limit=` | Payment history with status and whether a receipt is available. |
| `GET /api/parent/receipts/:txHash[?format=pdf]` | Receipt JSON, or PDF download. |
| `POST /api/parent/disputes` `{ txHash, reason, raisedBy? }` | Opens a dispute on one of the family's payments (`409` if one is already active), and pauses reminders the same way a staff-raised dispute does. |
| `PUT /api/parent/students/:studentId/preferences` `{ reminderOptOut }` | Turn reminder emails off / on. |

Error codes on `401`: `PARENT_TOKEN_MISSING`, `PARENT_TOKEN_INVALID`,
`PARENT_TOKEN_EXPIRED`, `PARENT_TOKEN_REVOKED`.

## Not yet included

- Per-term balances (needs terms / academic periods on balances).
- Passwordless email OTP login as an alternative to links.
- SMS delivery of links.
- A staff UI for issuing / revoking links (the API above is complete).
