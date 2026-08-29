# StellarEduPay Operator Runbooks

These runbooks cover the main operational failures for the async payment path: Redis or queue outage, Horizon outage, Mongo or database outage, stuck payments, key rotation, and restore.

## General Incident Steps

1. Open an incident record with time, environment, reporter, and affected tenants.
2. Assign an incident commander, API operator, database operator, and communications owner.
3. Freeze non-essential deployments.
4. Preserve logs, queue state, deployment SHA, and database snapshot metadata.
5. Decide whether to run in read-only mode, maintenance mode, or full recovery mode.

## Redis Or Queue Down

Symptoms: payment requests are accepted but not processed, workers cannot dequeue jobs, retry counts stop changing, or queue health checks fail.

Response: put payment creation into read-only mode if jobs cannot be durably enqueued, stop failing workers if they increase load, check connection strings and capacity, confirm queued jobs are preserved, and restart workers after health is restored.

Recovery checks: no duplicate jobs for the same idempotency key, dead-letter queue reviewed, stuck payments retried or marked manual-review, and user-visible status is accurate.

## Horizon Or Stellar Network Down

Symptoms: transaction submission fails or times out, ledger reads are delayed, payments remain submitted or unknown, or reconciliation jobs fail across many tenants.

Response: stop new submissions if failures are widespread, keep reconciliation retries with bounded backoff, switch to an approved backup endpoint only if configured, and do not mark unknown payments as failed until ledger status is confirmed.

## Mongo Or Database Down

Symptoms: API cannot load sessions, tenants, or payments; workers cannot persist status changes; audit event writes fail.

Response: stop new payment writes, stop workers before they perform external writes that cannot be persisted, preserve logs and metrics, restore service or fail over, and run integrity checks before re-enabling workers.

## Stuck Payments

Triage payment ID, tenant ID, user ID, idempotency key, amount, asset, destination, current state, last worker attempt, transaction hash, and last Horizon response.

Procedure: if a transaction hash exists, query Stellar/Horizon directly. If confirmed, update payment state with an audit reason. If failed, mark failed with the failure reason. If no hash exists and no transfer occurred, retry from queued state. If state is ambiguous, keep manual-review and do not retry automatically.

## Secret Provisioning

Before deploying the backend for the first time in any environment, provision
the `stellaredupay` Kubernetes Secret using the scripted process below. Never
use a hand-typed `kubectl create secret` command — the script validates inputs,
is idempotent, and emits an audit trail for your change-management log.

**Checklist — run before every new environment or after a credential reset:**

1. Generate values for all required secrets (see script header for generation
   commands): `JWT_SECRET`, `MONGO_URI`, and (for production) `SIGNER_MASTER_KEY`.
2. Verify you are targeting the correct cluster context:
   `kubectl config current-context`
3. Run the provisioning script:
   ```sh
   JWT_SECRET=<value> MONGO_URI=<value> SIGNER_MASTER_KEY=<value> \
     NAMESPACE=<namespace> \
     ./scripts/provision-k8s-secrets.sh
Record the script's audit output (context, operator, timestamp) in your
incident or change-management log.
Deploy via the environment overlay — not the base manifest directly:
kubectl apply -k deploy/k8s/overlays/mainnet   # production
kubectl apply -k deploy/k8s/overlays/testnet   # staging
Verify the backend pods reach Running state and the /health endpoint
returns {"status":"healthy"}.
The script (scripts/provision-k8s-secrets.sh) uses --dry-run=client | apply
so it is safe to re-run; it patches an existing secret without error.
Key Rotation
Rotate JWT secrets, webhook secrets, database credentials, queue credentials, deployment tokens, and Stellar signing credentials when compromise is suspected, operator membership changes, or the scheduled interval expires.
General rotation order (used for any credential not covered by a script below): create replacement secret, deploy dual-read support if required, rotate provider-side secret, redeploy API and workers, revoke old secret, verify operations, and record rotation time and operator.
JWT secret — node scripts/rotate-jwt-secret.js --confirm
Generates a new secret, patches the stellaredupay Kubernetes Secret's JWT_SECRET, and rolls deployment/backend — the create/rotate/redeploy/revoke sequence above run as one script instead of hand-typed kubectl commands, removing the risk of doing those steps out of order.
This is a hard cutover (JWT_SECRET has no dual-secret verification support): every live session is invalidated immediately, and stored MFA secrets — encrypted with a key derived from JWT_SECRET — become undecryptable, so enrolled users must re-enroll MFA. --confirm is required and is the human review/approval gate: read the script's header comment for the full list of side effects before running it. Pass --secret-name, --deployment, or --namespace to target a non-default Secret/Deployment/namespace (e.g. to rehearse against a staging cluster first).
Stellar signing credential — node scripts/rotate-signer-master-key.js [--apply]
Rotates SIGNER_MASTER_KEY, the key that encrypts Stellar signing secret keys at rest (backend/src/utils/signerKeyManager.js). Set SIGNER_MASTER_KEY_OLD to the key currently protecting stored records and SIGNER_MASTER_KEY to the replacement, then run the script: it re-encrypts every school's stored signing key under the new key and reports per-record success/failure. Defaults to a dry run (decrypts and re-encrypts in memory without writing) so a bad key pair is caught before any record is touched; pass --apply to persist. After a successful --apply run, update the deployment's SIGNER_MASTER_KEY secret (dropping SIGNER_MASTER_KEY_OLD), redeploy, verify a test decrypt/sign, and record the rotation time and operator.
Other credentials
Webhook secrets, database credentials, queue credentials, and deployment tokens do not yet have scripted rotation — follow the general rotation order above and record the rotation in the incident log.
Restore Procedure
Stop API writes and workers.
Create a forensic snapshot of the current database.
Restore the latest known-good backup into staging.
Run migrations and integrity checks against staging.
Compare restored payments with on-chain transaction state.
Decide whether to promote the backup or repair selected records.
Communicate RPO impact before production promotion.
Resume workers only after database and queue state are consistent.
Running the Restore Script
The restore script (scripts/restore.sh) uses safe defaults — it will not drop
existing collections unless you explicitly request it.
Safe defaults (no data loss risk)
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260324T120000Z.gz \
  ./scripts/restore.sh
This merges the backup into the existing database. Records already in the database
are preserved; the backup fills in anything that is missing.
Dry-run mode — preview without mutation
Use --dry-run (or DRY_RUN=true) to print the target URI and the exact
mongorestore command that would be executed, without touching the database:
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260324T120000Z.gz \
  ./scripts/restore.sh --dry-run
Always run dry-run first in production to confirm the correct archive and URI
before committing to the restore.
Drop-and-replace restore (destructive — requires confirmation)
Set DROP=true (or pass --drop) to drop existing collections before restoring.
The script will prompt for confirmation before proceeding:
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260324T120000Z.gz \
DROP=true \
  ./scripts/restore.sh
WARNING: You are about to DROP existing collections on mongodb://localhost:27017/stellaredupay.
         This will permanently delete all data in those collections before
         restoring from: ./backups/20260324T120000Z.gz

Are you sure? [y/N]
You must type y or Y to proceed; any other input aborts the restore.
Bypassing the interactive prompt (scripted pipelines)
Pass --yes or -y to skip the interactive confirmation. Only use this in
automated pipelines where the intent to drop has already been reviewed:
MONGO_URI=mongodb://localhost:27017/stellaredupay \
BACKUP_FILE=./backups/20260324T120000Z.gz \
DROP=true \
  ./scripts/restore.sh --yes
Never combine --yes with an unreviewed MONGO_URI in production scripts.
Image tags and rollbacks
First-party images are pinned by commit SHA in each Kustomize overlay:
images:
  - name: stellaredupay/backend
    newTag: sha-abc1234
  - name: stellaredupay/frontend
    newTag: sha-abc1234
Promote testnet → mainnet
Validate the build on testnet (kubectl apply -k deploy/k8s/overlays/testnet).
Copy the same newTag into overlays/mainnet/kustomization.yaml.
Open a PR — the diff is a one-line tag change.
After merge: kubectl apply -k deploy/k8s/overlays/mainnet.
Rollback
kubectl rollout undo deployment/backend
kubectl rollout undo deployment/frontend
Because the previous ReplicaSet still references the old immutable tag, undo restores that exact image (not whatever :latest points at).
MongoDB
deploy/k8s/mongodb-statefulset.yaml runs a single replica (replicas: 1) with no --replSet. This is intentional for the in-cluster baseline; multi-document transactions require a replica set or an external managed MongoDB (e.g. Atlas).

Backend auto-scaling
deploy/k8s/backend-hpa.yaml defines a HorizontalPodAutoscaler for the backend Deployment: it scales between 2 and 10 replicas, targeting 70% average CPU utilization across pods. This handles end-of-term fee-collection peaks without manual `kubectl scale`. The Deployment's `replicas: 2` field is only the starting point once the HPA is applied — the HPA takes over adjusting replica count from there. Tune `minReplicas`/`maxReplicas`/`averageUtilization` in that file if peak load patterns change.
