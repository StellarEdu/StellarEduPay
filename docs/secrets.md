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
| `REDIS_PASSWORD` | |
| `MONGO_URI` | Connection string including credentials |

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
