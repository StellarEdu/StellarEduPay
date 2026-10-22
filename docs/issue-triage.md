# Issue triage guide

This project handles payments and school data. Triage should reduce duplicate work while preserving a clear audit trail for regressions and security-sensitive changes.

## Before opening or closing an issue

1. Search open and recently closed issues using the error message, endpoint, job name, and the user-visible symptom.
2. Check linked pull requests and commits, not only the issue title. A closed issue is not proof that the fix reached `main`.
3. If an issue is a duplicate, link the canonical issue and explain what information was preserved. Do not silently close a report that contains new reproduction evidence.
4. For a claimed regression, reproduce against the current `main` branch and record the commit, environment, steps, expected result, and actual result.

## Labels and priority

Use one type label and one area label where possible:

- `bug`: behavior differs from the documented contract.
- `regression`: behavior worked on a known earlier revision and is broken on `main`.
- `security`: confidentiality, integrity, authentication, authorization, supply-chain, or secret exposure concern.
- `enhancement`: requested behavior that is not currently broken.
- `needs-info`: reproduction or impact details are missing.
- `duplicate`: the report is covered by another issue; link it in the closing comment.

Prioritize incidents that can move or expose money, bypass tenant isolation or authorization, leak secrets or student data, corrupt audit trails, or block all deployments. Supply-chain and production authentication issues require maintainer review before being downgraded.

## Minimum actionable report

A report is ready for engineering when it has:

- a concise symptom and affected area;
- deterministic reproduction steps or a representative failing request;
- expected and actual behavior;
- environment and commit/PR where the behavior was observed;
- impact, including affected users, data, payments, and rollback risk;
- logs or screenshots with secrets, wallet keys, tokens, and personal/payment data removed.

Use `needs-info` rather than closing a potentially valid report when one focused clarification could make it actionable.

## Regression and duplicate workflow

For a suspected regression:

1. Reproduce on the latest `main`.
2. Identify the last known-good revision or related change when practical.
3. Link the regression issue to the suspected introducing PR.
4. Add a regression test or an explicit verification step to the fixing PR.
5. Keep the issue open until the fix is merged and the verification evidence is recorded.

For duplicates, close with `Duplicate of #<canonical-issue>` and preserve any distinct logs, affected versions, or security impact in the canonical issue or a linked comment.

## Closing evidence

A maintainer may close an issue when one of the following is documented:

- the linked PR merged and its CI checks passed;
- the behavior was verified as fixed on `main` or in the deployed environment;
- the report is a confirmed duplicate, invalid, or intentionally out of scope with an explanation;
- the reporter confirmed resolution.

If a bundled PR fixes several issues, link each issue explicitly in the PR body and record the specific file, test, or deployment evidence for each one. Do not use a closing keyword without that traceability.
