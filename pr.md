# Fix: the syntax gate never ran — pure-Node `check:syntax` without `glob`

Closes #1267

## Summary

`npm run check:syntax` — the first gate the CI `test` job runs — could not run at all. `scripts/check-syntax.js` required `glob`, which is declared in no `package.json` in this repository, so the script died with `MODULE_NOT_FOUND` on its second line and took the CI step down with it. The project had a syntax gate on paper and none in practice, which is how a duplicate `const` declaration in `backend/src/routes/paymentRoutes.js` reached main and broke the build for everyone.

This PR rewrites the script as a zero-dependency tool matching the sibling convention (`scan-example-secrets.js`, `validate-migrations.js` — *"No dependencies required — pure Node"*), extends coverage to both backend and frontend sources, and makes the script's own failure distinguishable from a detected syntax error.

## Before vs after

| | Before | After |
|---|---|---|
| Runs at all | ❌ `Cannot find module 'glob'`, exit non-zero, always | ✅ exits 0 on clean trees |
| Coverage | `backend/src/**/*.js` only | `backend/src` **and** `frontend/src` (245 files) |
| JSX handling | none | `@babel/core.parseSync` (already-declared root devDependency) |
| Backend parsing | `node --check` | unchanged — the real runtime parser |
| Failure semantics | every failure looked identical | exit `0` clean · `1` syntax error found (names file + line) · `2` gate broke (`[check-syntax] GATE ERROR`) |

## Changes

### Modified

| File | Description |
| ---- | ----------- |
| [`scripts/check-syntax.js`](scripts/check-syntax.js) | Rewritten: recursive walk via `fs.readdirSync(dir, { recursive: true })` (Node ≥ 18.17; `.nvmrc` pins 20.11) replaces `glob`; `node --check` for backend sources; JSX-aware Babel parse for frontend; distinct exit codes 0/1/2 with `[check-syntax] GATE ERROR` prefix for startup failures; exported functions stay unit-testable. |
| [`backend/src/routes/paymentRoutes.js`](backend/src/routes/paymentRoutes.js) | Companion one-line fix: removes the duplicate `requireSchoolAuth` import (the exact breakage the dead gate let reach main). The rewritten gate flagged this file on its very first run against the broken tree. |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Comment on the *Syntax check* step documents the dependency posture and the 0/1/2 exit-code contract. Step invocation itself is unchanged. |
| [`CHANGELOG.md`](CHANGELOG.md) | `[Unreleased]` entry under Fixed. |

### Added

| File | Description |
| ---- | ----------- |
| [`tests/checkSyntax.test.js`](tests/checkSyntax.test.js) | 14 tests: fixture-based unit tests for both parsers (duplicate declarations, malformed syntax, broken JSX — each asserting file + line are named), the exit-code contract (clean → 0, errors → 1, zero files walked / missing dir → GateError), and an integration run of the real CLI against the live repository expecting exit 0. |

No new dependencies: the script requires only Node's standard library plus `@babel/core`, which was already a declared root devDependency.

## Acceptance criteria mapping

| Criterion (from #1267) | Status |
|---|---|
| `npm run check:syntax` runs to completion from a clean `npm ci`, no extra install steps | ✅ verified: `✓ 245 files passed the syntax check (backend/src: 200, frontend/src: 45)`, exit 0 |
| Run against current main reports the `paymentRoutes.js` duplicate-declaration instead of crashing | ✅ demonstrated live: `SYNTAX ERROR in backend/src/routes/paymentRoutes.js:62 … Identifier 'requireSchoolAuth' has already been declared`, exit 1 |
| Script declares everything it requires, or requires nothing outside the standard library | ✅ stdlib only for walking/`node --check`; `@babel/core` is already declared in root `package.json` |
| A deliberate error in any backend or frontend source file exits non-zero naming file + line | ✅ unit fixtures cover both parsers; live probe produced `SYNTAX ERROR in frontend/src/pages/<file>:<line>` and exit 1 |

## Testing

- `tests/checkSyntax.test.js`: 14/14 passing (~11 s, includes one real CLI integration run).
- Full `npm test` compared against the pre-fix baseline: **zero new failing suites**; 19 previously-red suites pass again because removing the duplicate import lets them load `app.js`. Remaining failures reproduce identically on the base commit (environment-dependent: mongodb-memory-server, SMTP DNS flakes, missing test-only modules) and are untouched by this PR.
- ESLint: no lint config applies to root `scripts/`; code follows the house style of the neighbouring scripts.

## Deployment notes

- No runtime behaviour changes — this touches CI tooling plus a one-line import repair.
- Rate-limit knobs, APIs, and schemas are unaffected.
- Merge-order note: if the parallel security PR (which also removes the same duplicate import line) merges first, git auto-resolves the identical deletion on rebase — no manual conflict resolution expected.
