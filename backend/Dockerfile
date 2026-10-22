# node:20-alpine pinned to this immutable manifest digest.
# Node major version — keep in sync with the root .nvmrc.
# Override at build time: docker build --build-arg NODE_VERSION=24 ...
ARG NODE_VERSION=24
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# tini: init process for PID 1 — forwards signals to Node and reaps zombies
# node healthcheck: inline Node script replaces curl (smaller attack surface)
RUN apk add --no-cache tini

# Fixed UID/GID 1001 so runAsUser in K8s matches file ownership
RUN addgroup -S -g 1001 appgroup && adduser -S -u 1001 -G appgroup appuser

# Default to production so the app doesn't serve Swagger, skips insecure
# branches, and sets secure cookie flags even without an explicit override.
ENV NODE_ENV=production

# Build metadata (#1634) — reported by GET /api/version, /health/live and the
# build_info metric. Supplied by .github/workflows/release.yml.
ARG APP_VERSION=""
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

WORKDIR /app

COPY package*.json ./

# Migrations and the deploy-time migration CLI must be in the image.
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

# Own everything as the non-root user
RUN chown -R appuser:appgroup /app

USER appuser

COPY . .

# Use a tiny Node one-liner instead of curl: same result, no extra package.
# Checks /health/live (process-alive probe, no external calls).
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e \
  "const h=require('http');h.get('http://localhost:'+process.env.PORT||5000+'/health/live',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# tini as PID 1: forwards SIGTERM/SIGINT to Node and reaps zombie processes.
# Node is invoked directly (not via npm) so it receives signals reliably.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
