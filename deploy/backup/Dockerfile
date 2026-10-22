# Backup tooling image (issue #1630).
#
# mongo:7 ships mongodump/mongorestore/mongosh but not the encryption or
# object-storage clients backup.sh needs, nor the scripts themselves (needed in
# Kubernetes, where the repo is not mounted). Build from the repo root:
#
#   docker build -f deploy/backup/Dockerfile -t stellaredupay/backup-tools:<sha> .
FROM mongo:7

RUN apt-get update \
 && apt-get install -y --no-install-recommends age gnupg awscli curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY scripts/backup.sh scripts/restore.sh scripts/verify-latest-backup.sh scripts/test-backup-recovery.sh /scripts/
COPY scripts/lib/ /scripts/lib/

# Kubernetes runs this as the image's unprivileged mongodb user (UID 999) via
# securityContext; Compose keeps root so it can write the host-mounted /backups.
WORKDIR /tmp
ENTRYPOINT []
CMD ["bash", "/scripts/backup.sh"]
