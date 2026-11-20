# Secrets: environment variables and `*_FILE` references

Every secret the backend reads can be supplied either directly or as a file
path (issue #1829). File delivery is what Docker Swarm / Compose `secrets:`,
Kubernetes projected Secret volumes and the official Postgres and Mongo images
use, and it keeps values out of `docker inspect`, `/proc/<pid>/environ` and
crash dumps.

## Supported secrets

| Variable | Notes |
|---|---|
| `JWT_SECRET` | ≥ 32 characters |
| `RECEIPT_SIGNATURE_SECRET` | |
| `ADMIN_PASSWORD`, `ADMIN_PASSWORD_HASH` | Either may be used |
| `STUDENT_PII_ENCRYPTION_KEY` (+ `_PREVIOUS`) | 64 hex characters |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | 64 hex characters |
| `AUDIT_HMAC_KEY` | |
| `METRICS_BEARER_TOKEN` | |
| `SMTP_PASS`, `SENDGRID_API_KEY`, `TWILIO_AUTH_TOKEN` | |
| `ANCHOR_PLATFORM_KEYPAIR` | Stellar secret key |
| `REDIS_PASSWORD` | Required when `NODE_ENV=production`; must match the Redis `requirepass` |
| `MONGO_URI` | Connection string including credentials (use the least-privilege app user) |
| `MONGO_KEYFILE` | Replica-set keyFile contents; mounted at mode `0400` and passed as `--keyFile` |
| `MONGO_APP_PASSWORD` | Password for the application user (`readWrite` on `stellaredupay` only) |
| `MONGO_BACKUP_PASSWORD` | Password for the backup user (`backup` role) |

The full list lives in `backend/src/config/secrets.js` (`SECRET_ENV_KEYS`).

## Using a file

```yaml
# docker-compose.yml (excerpt)
services:
  backend:
    environment:
      JWT_SECRET_FILE: /run/secrets/jwt_secret
    secrets:
      - jwt_secret
secrets:
  jwt_secret:
    file: ./secrets/jwt_secret.txt
```

Rules applied at boot, before any other module reads the environment:

- The file is read, one trailing `\n` or `\r\n` is removed, and the value is
  placed in `process.env[NAME]`.
- Setting both `NAME` and `NAME_FILE` is an error. This prevents a stale
  variable from silently overriding a rotated file.
- An empty or unreadable file is an error (fail closed).
- `*_FILE` variables for these secrets are redacted in config logs.

## Rotation

Files are read once at boot, so rotating any secret requires a restart.
`STUDENT_PII_ENCRYPTION_KEY_PREVIOUS` is the existing grace key for PII
encryption, so the old key can still decrypt records during a rotation.
Per-secret impact of rotation (for example, whether existing JWTs stop
verifying) is not yet documented here.

### Redis

`REDIS_PASSWORD` is required when `NODE_ENV=production`; the backend refuses to
boot without it. Rotating it requires updating the Redis `requirepass` (or ACL
user) and every client (`REDIS_PASSWORD` / `REDIS_URL`) together, then
restarting both. Until the restart completes, clients with the old password are
rejected and BullMQ workers will log connection errors.

### MongoDB

The keyFile is shared by every replica-set member, so `MONGO_KEYFILE` must be
identical across the StatefulSet. Rotating it requires a rolling restart of all
members with the new file in place; members with a mismatched keyFile cannot
authenticate to each other.

`MONGO_APP_PASSWORD` and `MONGO_BACKUP_PASSWORD` are created by
`scripts/provision-k8s-secrets.sh`. Rotate the app-user password and the
`MONGO_URI` in the app Secret together — a `MONGO_URI` carrying the old
password fails authentication. The backup user's password and the backup
CronJob's Secret must likewise be rotated together.
