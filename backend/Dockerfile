# node:20-alpine pinned to this immutable manifest digest.
# Node major version — keep in sync with the root .nvmrc.
# Override at build time: docker build --build-arg NODE_VERSION=24 ...
ARG NODE_VERSION=24
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps

# Stage 1 — production dependencies only (#1930). Only the manifests are
# copied here, so this layer is cached until package*.json changes and no
# host node_modules (built for another OS/libc) can leak into the image.
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

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

# Source is copied with explicit ownership: COPY ignores USER, so a plain
# `COPY . .` after `USER appuser` would leave everything root-owned (#1930).
# The .dockerignore file keeps .env files, logs, tests and host artifacts out.
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

# The logger writes to ./logs at runtime, so that directory must be writable.
RUN mkdir -p /app/logs && chown appuser:appgroup /app /app/logs

USER appuser

# Port the server listens on. Kept in sync with the default in src/config.
ENV PORT=5000

# Use a tiny Node one-liner instead of curl: same result, no extra package.
# Checks /health/live (process-alive probe, no external calls) on the port
# the server actually listens on (#1931). Defaulting with `||` inside the
# parentheses keeps the URL well-formed whether or not PORT is set.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e \
  "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# tini as PID 1: forwards SIGTERM/SIGINT to Node and reaps zombie processes.
# Node is invoked directly (not via npm) so it receives signals reliably.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
