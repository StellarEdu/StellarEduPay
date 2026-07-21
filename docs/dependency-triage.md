# Dependency Security Advisory Triage Process

## Overview

CI runs `node scripts/check-dependency-audit.js` for all three packages (root, backend,
frontend). It runs `npm audit --json` and fails the build on any **high** or **critical**
advisory that has no current, non-expired entry in [`security-exceptions.json`](../security-exceptions.json).
Dependabot opens weekly PRs for outdated dependencies.

## When CI Fails with a Vulnerability

1. **Check the advisory**: run `npm audit` locally in the affected package directory.
2. **Apply the fix** if a patched version exists:
   ```bash
   npm audit fix          # non-breaking upgrades only
   npm audit fix --force  # may include semver-major upgrades — review carefully
   ```
3. **Review the diff**: confirm the updated package doesn't introduce breaking changes.
4. **If no fix is available** (zero-day / no upstream patch):
   - Open a GitHub issue tagged `security` with the advisory CVE/ID and affected paths.
   - Assess exploitability in context (e.g. a server-side-only dep used only in tests).
   - If safe to defer, add an entry to `security-exceptions.json` (repo root):
     ```json
     {
       "id": "GHSA-xxxx-xxxx-xxxx",
       "package": "package-name",
       "path": "backend",
       "severity": "high",
       "reason": "Why this is safe to defer, in context.",
       "issue": "https://github.com/<org>/<repo>/issues/<n>",
       "added": "2026-07-20",
       "expires": "2026-10-20"
     }
     ```
     `path` must match the package the CI audit step runs against (`.`, `backend`, or
     `frontend`). `id` is the advisory's GHSA slug (the last path segment of its
     `github.com/advisories/...` URL). `scripts/check-dependency-audit.js` treats an
     exception whose `expires` date has passed as if it didn't exist, so the build
     fails again until the entry is renewed (with a fresh look at whether a fix has
     since landed) or the vulnerability is fixed.
   - Do **not** silence the audit without a corresponding exception entry.

## Dependabot PRs

- Dependabot opens PRs weekly for outdated dependencies.
- Each PR runs the full CI suite including the audit job.
- Merge promptly for patch/minor updates that pass CI.
- Review carefully for major version bumps — check the package CHANGELOG first.

## Severity Reference

| Level    | Action Required        |
|----------|------------------------|
| critical | Fix immediately         |
| high     | Fix before next release |
| moderate | Fix within 30 days      |
| low/info | Fix opportunistically   |
