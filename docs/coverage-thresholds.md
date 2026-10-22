# Jest Coverage Thresholds

> Closes #1389

Coverage thresholds prevent regressions from silently reducing test coverage.
Jest exits non-zero when any configured threshold is breached, which causes the
`coverage` CI job to fail and, via the `ci-gate` job, blocks the pull request.

---

## Ratchet (#1635)

The Jest thresholds below are hard floors. On top of them, the `coverage` CI
job runs `scripts/coverage-ratchet.js`, which compares the run against the
committed `coverage-baseline.json` and **fails if coverage decreases**:

- any global metric (lines / statements / functions / branches) of the backend
  or frontend suite drops more than 0.1 pp below the baseline, or
- the line coverage of any file changed in the PR drops below its baseline.

The result is posted as a sticky PR comment and uploaded as the `coverage`
artifact.

When coverage improves, raise the baseline (it never moves down) and sync the
Jest global floors in one step:

```bash
npm run coverage && npm run coverage:frontend
npm run coverage:ratchet -- --update   # rewrites coverage-baseline.json, package.json, frontend/jest.config.js
```

Commit the three changed files with the PR that added the tests.

### Router inventory

`tests/routerInventory.test.js` fails when a file in `backend/src/routes/` is
not required by the app (unless listed in its `KNOWN_UNMOUNTED` ratchet, which
may only shrink), throws at require time, or registers no routes. It caught
`disputeRoutes.js` referencing `requireSchoolAuth` without importing it.

### Still to do

- Supertest smoke tests through the real app for each router.
- React Testing Library tests for `PaymentForm`, `VerifyPayment`,
  `ReportDownload` and each admin page's load / error states, with the API
  mocked at the HTTP layer.

---

## Current thresholds

### Backend (`package.json` → `jest.coverageThreshold`)

| Scope | Branches | Functions | Lines | Statements |
|-------|----------|-----------|-------|------------|
| global | 46 % | 37 % | 51 % | 51 % |
| `backend/src/services/` | 45 % | 51 % | 53 % | 52 % |
| `backend/src/middleware/` | 45 % | 42 % | 52 % | 50 % |
| `backend/src/controllers/` | 32 % | 32 % | 37 % | 36 % |

### Frontend (`frontend/jest.config.js` → `coverageThreshold`)

| Scope | Branches | Functions | Lines | Statements |
|-------|----------|-----------|-------|------------|
| global | 47 % | 22 % | 39 % | 38 % |

---

## Incremental improvement plan

The values above are the **floor** — the minimum acceptable coverage today.
Raise them as the test suite improves. A recommended cadence:

| Sprint | Target delta | Example new global (backend) |
|--------|-------------|-------------------------------|
| Now | Baseline | 46 % branches |
| +1 | +5 pp | 51 % branches |
| +2 | +5 pp | 56 % branches |
| … | … | … |
| Long-term | ≥ 80 % | 80 % branches |

**Rules for changing thresholds:**

1. Only raise thresholds — never lower them without an explicit decision logged
   in the PR description and a follow-up issue to restore them.
2. When adding a new per-directory threshold, start at the current measured
   value (round down to the nearest 5 pp) so the change is immediately green.
3. Run `npm run coverage` locally and confirm the summary before pushing.

---

## How enforcement works

```
npm run coverage          # root: backend source under tests/
npm run coverage:frontend # frontend: src/ under src/**/__tests__/
```

Both commands are run in the `coverage` CI job (`.github/workflows/ci.yml`).
The `ci-gate` job lists `coverage` in its `needs` array, so any threshold
breach blocks the PR through the single required status check **"CI gate"**.

To see which files are below threshold locally:

```bash
npm run coverage -- --coverageReporters=text 2>&1 | grep -E "Uncovered|FAIL"
```

---

## Adding a new threshold

1. Measure current coverage for the target directory:
   ```bash
   npm run coverage -- --collectCoverageFrom='backend/src/utils/**/*.js' \
     --coverageReporters=text-summary
   ```
2. Round the measured values **down** to the nearest whole number.
3. Add an entry under `coverageThreshold` in `package.json` (backend) or
   `frontend/jest.config.js` (frontend).
4. Open a follow-up issue to raise the value to 80 % over subsequent sprints.
