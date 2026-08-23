# Reconciliation: IMPLEMENTATION_SUMMARY.md vs. historical issue backlogs

**Verified against live code on:** 2026-07-24

## Context

`IMPLEMENTATION_SUMMARY.md` (branch `fix/559-560-561-562`, 2026-05-27) claims three problems were fixed:

1. `syncAllPayments` calling `syncPaymentsForSchool` twice / sending two responses (#559, #560)
2. Cross-school data isolation gaps in payment queries (#561)
3. Missing authentication on write endpoints (#562)

In some forks of this repository, later static backlog documents (`issues.md`, `GITHUB_ISSUES.md`, `PROJECT_ISSUES.md`) listed what read as the same three problems as still open, with full problem/fix/acceptance-criteria writeups — appearing to contradict this summary.

Those three files don't exist in this repository. They were deliberately removed here in `99a414e` ("docs: remove three redundant, contradictory issue-backlog files", closing #1110), on the grounds that three overlapping, audit-generated markdown backlogs with no canonical status are unreliable and that the live GitHub Issues tracker is this project's single source of truth. That removal resolves the *documentation* contradiction directly — there's no still-open static claim left to reconcile against `IMPLEMENTATION_SUMMARY.md` in this repo.

What that removal doesn't establish on its own is whether the underlying **code claims** in `IMPLEMENTATION_SUMMARY.md` still hold. This document verifies that directly against current code, so a reader doesn't have to take either the summary or a deleted backlog's word for it.

## Verified current state

### 1. Duplicate `syncAllPayments` call — still fixed
`backend/src/controllers/paymentAdminController.js:33-79`: `syncPaymentsForSchool(req.school)` is called exactly once (line 52), `res.json()` exactly once on the success path. The function has since gained a distributed Redis lock (`Issue #69`) on top of the original fix, and the duplicate-call bug has not reappeared.

### 2. Cross-school data isolation — still fixed
`backend/src/controllers/paymentQueryController.js`: `getStudentPayments` scopes the student lookup and payment find/count by `schoolId` (lines 63, 71-73). `getStudentBalance` scopes the student lookup, the main balance aggregation, and the category-breakdown sub-aggregation all by `schoolId` (lines 190, 195, 220).

### 3. Missing write-endpoint authentication — still fixed
Every endpoint named in the original fix carries `requireAdminAuth` today: student routes (`studentRoutes.js`), fee routes (`feeRoutes.js`), school routes (`schoolRoutes.js`), and `POST /api/payments/sync` / `PATCH /api/payments/:txHash/status` (`paymentRoutes.js`).

## A related gap — read-endpoint header trust (filed separately, now fixed)

Most payment **read** endpoints trusted the `X-School-ID`/`X-School-Slug` header alone — `resolveSchool` (`backend/src/middleware/schoolContext.js`) only validated tenant binding against a JWT when one happened to be present on the request. That was a header-trust gap specific to reads, distinct from the write-endpoint `requireAdminAuth` gap fixed in #562, and it was tracked as its own GitHub issue rather than folded into this reconciliation.

**Status: fixed.** The follow-up issue closed with: authentication required on every dispute and fee-adjustment handler (including the previously anonymous `GET /api/disputes`, `GET /api/disputes/:id`, `POST /api/disputes` and `GET /api/fee-adjustments`); `resolveSchool` now returns 401 for a present-but-invalid token instead of falling through to anonymous; unknown and inactive schools produce identical responses so resolution is no longer an enumeration oracle; a documented public-endpoint allowlist (`backend/src/config/publicEndpoints.js`) captures every intentionally-anonymous route with its threat model; `tests/allRoutesRequireAuth.test.js` enforces on CI that no mounted route reaches a controller without authentication unless allowlisted; and `docs/threat-model.md` ("Identifiers Are Not Credentials") records the model. See that document for details.

## Disposition

`IMPLEMENTATION_SUMMARY.md` is accurate and current; no change needed there beyond a pointer to this document. No other repository markdown currently contradicts it. If a future static backlog is reintroduced and drifts out of sync again, prefer filing/updating a GitHub issue over trusting either document at face value — see the rationale in `99a414e`.

---

# Reconciliation: docs/issue-intake.md vs. PROJECT_ISSUES.md claim that GitHub Issues are disabled

**Verified 2026-07-28**

## Context

`docs/issue-intake.md` (added 2026-07-04) states that GitHub Issues is the intake channel for this repository and documents the full bug-report template and maintainer-triage process.

`PROJECT_ISSUES.md` (AI-generated audit, dated 2026-06-24, deleted in `99a414e` on 2026-07-22) contained the following claim in issue #150:

> "GitHub Issues are also disabled on the active fork, so there's no contribution intake path."

This is a direct contradiction: one document describes a fully functioning intake process; the other says no intake path exists.

## Resolution

The contradiction is resolved and the claim in `PROJECT_ISSUES.md` was stale at the time it was written:

1. **Timeline:** `PROJECT_ISSUES.md` was generated on 2026-06-24. `docs/issue-intake.md` was added on 2026-07-04 — eleven days later — explicitly establishing the intake path the audit claimed was missing. By the time the audit file was removed (2026-07-22), the gap it identified had already been closed.

2. **GitHub Issues are enabled and functional.** Issues have been filed, triaged, and closed on this repository throughout the project's history. The removal of `PROJECT_ISSUES.md` was itself tracked as issue #1110 and closed via the same commit (`99a414e`). The audit document's own acceptance criteria for issue #150 ("a working issue-intake path documented") was satisfied by `docs/issue-intake.md` before the audit file was even removed.

3. **The deleted file was unreliable.** `PROJECT_ISSUES.md` was one of three overlapping AI-generated backlogs removed in `99a414e` because they had no canonical status and actively contradicted each other and the codebase. Its claims about GitHub Issues availability should not be treated as authoritative.

4. **End-to-end verification:** `docs/issue-intake.md` documents intake via GitHub Issues; GitHub Issues are enabled on this repository; issues have been successfully filed and closed here. The process described in `docs/issue-intake.md` functions as documented.

## Disposition

`docs/issue-intake.md` is accurate. The claim from `PROJECT_ISSUES.md` was stale AI-generated content that has since been removed. A verification note has been added to `docs/issue-intake.md` directly so that any reader who encounters a reference to the old claim in git history has a clear, in-document explanation of its status.