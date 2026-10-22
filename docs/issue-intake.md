# Issue Intake Path

StellarEduPay accepts contribution and operations issues through GitHub Issues in this repository. This page defines the intake path so operators, maintainers, and contributors know where to file reports and what information to include.

## Where To File

Use GitHub Issues for bugs in frontend, backend API, worker, queue, webhook, database, Horizon/Stellar integration, documentation gaps, operator runbook updates, and feature requests.

Do not paste secrets, private keys, production tokens, user private data, or unreleased vulnerability details into public issues.

## Security-Sensitive Reports

If a report includes a live exploit, secret, private user data, or a way to move funds without authorization, do not file full details publicly. Open only a minimal public tracking issue if needed and contact maintainers through the private channel documented by the project owner.

## Bug Report Template

- Environment: local, staging, testnet, or production.
- Component: frontend, backend API, worker, queue, webhook, database, Horizon/Stellar.
- Expected behavior.
- Actual behavior.
- Reproduction steps.
- Safe request ID, payment ID, tenant ID, or transaction hash if available.
- Screenshots or logs with secrets removed.

## Operational Issue Template

- Incident time window in UTC.
- Affected tenants or users, if safe to share.
- Dependency involved: Redis, Horizon, Mongo, webhook provider, SSE, deployment, or signing.
- Current user impact.
- Actions already taken.
- Whether writes or workers are paused.

## Maintainer Triage

Maintainers should tag incoming issues by area, severity, status, and contributor fit. Payment, custody, authorization, tenant-isolation, or webhook issues should be reviewed before assignment.

## Status Verification Note

**Verified 2026-07-28.** A prior AI-generated audit document (`PROJECT_ISSUES.md`, issue #150, dated 2026-06-24) claimed "GitHub Issues are also disabled on the active fork, so there's no contribution intake path." That claim is stale and was superseded before the file was even removed:

- This document (`docs/issue-intake.md`) was added on 2026-07-04, establishing the intake path, nearly three weeks before the audit file was deleted.
- The audit file (`PROJECT_ISSUES.md`) was removed in commit `99a414e` (2026-07-22) along with two other overlapping AI-generated backlogs (`issues.md`, `GITHUB_ISSUES.md`) on the grounds that the live GitHub Issues tracker is the single source of truth for this repository.
- GitHub Issues are enabled and functional on this repository. Issues have been filed, triaged, and closed here throughout the project's history (e.g. #1110 tracked the removal of the redundant backlog files themselves).

The contradiction is resolved. This document accurately describes the working intake process.
