# Database migrations

Schema/data migrations live in [`backend/migrations/`](../backend/migrations).
Each file exports a `version` string plus `up()` (and optionally `down()`)
functions. They are executed in filename order by
[`backend/src/services/migrationRunner.js`](../backend/src/services/migrationRunner.js).

## How migrations run

There is a single entrypoint used everywhere:

```bash
# from the backend/ directory (or inside the container, where WORKDIR=/app)
npm run migrate            # apply all pending migrations
npm run migrate:rollback   # roll back the last applied migration
```

`runMigrations()` claims each migration atomically using the unique index on
`Migration.version` as a distributed lock, so it is **safe to run concurrently
from multiple instances** — only one applies a given migration and the rest
skip it. If a migration throws, its lock document is removed and the process
exits non-zero so the failure is loud and the deploy is blocked.

If the `migrations/` directory is missing entirely, `runMigrations()` throws
rather than silently returning — a missing directory means a broken image or
checkout, not "nothing to do".

## Where it runs automatically in the deployment pipeline

Migrations are wired into every deployment topology this repo describes, so a
new release's migrations are always applied **before traffic reaches the new
version**:

| Topology | Mechanism |
| --- | --- |
| Kubernetes (`deploy/k8s/backend-deployment.yaml`) | An `initContainer` runs `npm run migrate` to completion before the app container starts. A failed migration leaves the pod un-Ready and blocks the rollout. |
| Docker Compose (`docker-compose.yml`) | The `backend` service command is `sh -c "npm run migrate && npm start"`, so the server only starts after migrations succeed. |
| Local development | Run `npm run migrate` from `backend/` after pulling changes that add migration files. |

## Image contents

The production image **must** contain the migration files and the migration
CLI. [`backend/Dockerfile`](../backend/Dockerfile) copies both:

```dockerfile
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
```

Without these, `npm run migrate` cannot run and `runMigrations()` fails loudly
by design.

## Migrations 019–025 reference

Summary of what each of these migrations does, whether it's safe to run
during a rolling deploy, and any prerequisites an operator needs before
running `npm run migrate`. (See `CHANGELOG.md` for the same information in
release-note form.)

| Migration | What it does | Rolling-deploy safe? | Prerequisites |
| --- | --- | --- | --- |
| `019_add_reminder_time_window` | Backfills `schools.settings.reminderTimeWindow` to `{ startHour: 8, endHour: 18 }` on schools missing it. Data-only. | Yes — idempotent, no index/lock impact. | None. |
| `020_tenant_isolate_source_validation_rules` | Fixes #904: drops the old global-unique `name_1` index on `sourcevalidationrules`, creates a compound unique index on `{ schoolId, name }` plus a `{ schoolId }` lookup index, and backfills any rule missing `schoolId` to `DEFAULT_SCHOOL_ID` (default `"SCH-DEFAULT"`). | Caution — index creation is foreground (no `background: true`); can briefly hold a write lock on a large `sourcevalidationrules` collection. | **Operator action after running**: review rules that were backfilled to the default school — they were previously global and are now owned by one tenant. Optionally set `DEFAULT_SCHOOL_ID` before running to control the owning tenant. |
| `021_encrypt_webhook_secrets` | Encrypts existing plaintext `School.webhookSecret` values with AES-256-GCM (#75) and strips any lingering plaintext `secret` field from `WebhookRetry` documents. | Yes, once the key is set — idempotent (skips values already prefixed `enc:`). | **Must set `WEBHOOK_SECRET_ENCRYPTION_KEY`** (64-char hex) before running, or the migration no-ops and secrets remain plaintext (logged as a skip, not an error). |
| `022_create_reminder_logs` | Creates the `reminderlogs` collection with a unique compound index on `{ schoolId, studentId, windowStart }` (cross-replica reminder idempotency) and a TTL index on `createdAt`. | Yes — new collection, no contention with existing data. | None. Optionally set `REMINDER_LOG_TTL_SECONDS` to override the default 90-day retention. |
| `023_add_dispute_fields` | Adds evidence/SLA/escalation fields to existing `disputes` documents (`evidence`, `txReference`, `slaDeadline`, `slaBreachedAt`, `escalationLevel`, `escalatedAt`, `lastActivityAt`, `assignedTo`), computing `slaDeadline` from `createdAt + DISPUTE_SLA_HOURS`. Creates two non-unique indexes for SLA/escalation queries. | Yes, but the aggregation-pipeline `updateMany` backfill can take noticeable time on a large `disputes` collection. | Optionally set `DISPUTE_SLA_HOURS` (default 72) before running. |
| `024_add_underpaid_reconciliation_field` | Backfills an `underpaidReconciliation` sub-document onto every `payments` document that lacks one. Data-only. | Yes — idempotent, no index changes. | None. |
| `025_scope_payment_intent_memo_index` | Fixes #1202: drops the global-unique `memo` index on `paymentintents` and replaces it with a compound unique index on `{ schoolId, memo }`, built with `background: true`. | Yes — background index build, no write lock. Duplicate-memo protection is effectively index-less until the background build completes on large collections. | None. |

All seven are already ordered correctly by filename and require no manual
intervention beyond the prerequisites above — `npm run migrate` applies them
in sequence like any other migration.

## Recovering from the `_db` ReferenceError (pre-fix deployments)

Before this fix, `runMigrations()` referenced a `_db` variable that did not
exist in its scope, so **every** invocation of `npm run migrate` threw a
`ReferenceError` immediately after the migrations-directory check — before
any migration file was read or any lock document was written to the
`migrations` collection. The failure was loud (a non-zero exit code, a failed
CI step, a failed deploy/rollout), but it left **no record** of what was
attempted, so a database that went through this code path is in an unknown
state: some operators may have applied the pending migrations by hand,
skipped the step entirely and shipped anyway, or the deploy simply never went
out.

If you operate a database that was ever provisioned or deployed to through
`npm run migrate` before this fix, do not assume the `migrations` collection
reflects reality. Reconcile it before trusting it:

1. **List what the runner believes is applied.**
   ```js
   db.migrations.find({}, { version: 1, appliedAt: 1, lockedAt: 1 }).sort({ version: 1 })
   ```
   Any document with `lockedAt` set but no `appliedAt` is a stale lock from a
   run that crashed mid-migration (or from the `_db` bug itself, on versions
   of the runner old enough to write the lock before hitting the
   `ReferenceError` — check `git blame` on `migrationRunner.js` for your
   deployed version to see whether the lock write happened before or after
   the crash point). Stale locks block re-application; see below.

2. **Check each migration's actual effect against the database directly**,
   rather than trusting the collection. For index-creating migrations
   (`00[2346789]_*`, `012`, `015`, `016`, `018`, `025`), list existing indexes
   on the relevant collection and compare against what the migration file's
   `up()` creates:
   ```js
   db.<collection>.getIndexes()
   ```
   For backfill/encryption migrations (`001`, `005`, `010`, `011`, `013`,
   `021`, `024`), sample a handful of documents and check whether the fields
   the migration sets (e.g. an encrypted memo, a `deletedAt` backfill) are
   actually present.

3. **Reconcile the collection to match what you found in step 2** — do not
   just delete it and let the runner start clean, since a version marked
   "applied" that was never actually applied would then be silently skipped
   forever (the lock is a no-op skip, not a re-run):
   - A migration that **is** genuinely applied but has no `migrations`
     document (or only a stale lock): insert
     `{ version, appliedAt: new Date() }` so it is not re-run.
   - A migration that has an `appliedAt` but you cannot confirm its effect:
     treat this as the higher-risk case — read the migration's `up()` to
     understand whether re-running it is safe (most here are idempotent,
     e.g. `createIndex` and `$set`-style backfills guarded by a filter), and
     if so, delete its document and let the runner re-apply it; if not,
     apply the effect manually and then insert the `appliedAt` document.
   - A stale `lockedAt`-only document with no `appliedAt`: delete it so the
     migration is treated as pending again, after confirming (step 2) whether
     its `up()` partially ran and needs manual cleanup first.

4. **Only after reconciling**, run `npm run migrate` — from this point on,
   every future run is trustworthy: a completed migration always has both
   `version` and `appliedAt` recorded, because the fixed `runMigrations()` can
   actually reach that write.
