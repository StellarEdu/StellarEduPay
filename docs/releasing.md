# Releasing

> Closes #1634

StellarEduPay follows [Semantic Versioning](https://semver.org). Releases are
automated with [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release.yml`, `release-please-config.json`,
`.release-please-manifest.json`).

## How a release happens

1. PRs are squash-merged to `main` with a [Conventional Commits](https://www.conventionalcommits.org/) title:

   | Prefix | Changelog section | Version bump |
   |--------|-------------------|--------------|
   | `feat:` | Added | minor |
   | `fix:` | Fixed | patch |
   | `perf:` | Changed | patch |
   | `feat!:` / `fix!:` / `BREAKING CHANGE:` footer | Breaking | major |
   | `docs:` `chore:` `test:` `ci:` `refactor:` | hidden | none |

2. On every push to `main`, release-please updates a single open **release PR**
   that bumps `version` in the root, `backend/` and `frontend/` `package.json`
   files and adds a new section to `CHANGELOG.md`. Maintainers may edit the
   release PR to add operator notes (migrations, required env vars).
3. Merging the release PR creates the `vX.Y.Z` git tag and a GitHub release with
   the generated notes.
4. The `images` job then builds and pushes:
   - `ghcr.io/<owner>/stellaredupay-backend:X.Y.Z`, `:vX.Y.Z`, `:sha-<commit>`, `:latest`
   - `ghcr.io/<owner>/stellaredupay-frontend:` (same tags)

   with `APP_VERSION`, `GIT_SHA` and `BUILD_TIME` baked in as build args.

## Bootstrapping (one-off)

`v1.0.0` is the first tagged release; the manifest is already at `1.0.0` and
`CHANGELOG.md` holds the previously-unreleased history under `[1.0.0]`. After
this change is merged, a maintainer tags the merge commit once:

```bash
git tag -a v1.0.0 -m "v1.0.0" <merge-commit-sha>
git push upstream v1.0.0
```

and creates the matching GitHub release (or lets release-please create the
next one). From then on no manual tagging is needed.

## Which version is running?

| Where | What it reports |
|-------|-----------------|
| `GET /api/version` | `{ service, version, commit, buildTime, node }` |
| `GET /health/live` | `{ status, version, commit, timestamp }` |
| `/metrics` → `build_info{version, commit, node_version} 1` | per-replica version, for deploy annotations and version-skew alerts |
| Image label | `org.opencontainers.image.version` / `.revision` |

Rolling back means redeploying the previous `X.Y.Z` image tag.

## Breaking API changes and integrator notice

Breaking changes to the public API or webhook contract (e.g. the V1 webhook
signature sunset in [WEBHOOK_INTEGRATION.md](WEBHOOK_INTEGRATION.md)) must be
merged with a `!` / `BREAKING CHANGE:` footer so they land in a **major**
release, and should be announced under `### Deprecated` in at least one prior
release. The versioned `CHANGELOG.md` is the "developer changelog" referred to
in the webhook docs.
