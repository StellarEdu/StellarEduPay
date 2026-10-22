# ── Stage 1: build ────────────────────────────────────────────
# Node major version — keep in sync with the root .nvmrc.
# Override at build time: docker build --build-arg NODE_VERSION=24 ...
ARG NODE_VERSION=24
# node:20-alpine pinned to this immutable manifest digest.
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --ignore-scripts

# Issue #1583: NEXT_PUBLIC_STELLAR_NETWORK is now read at runtime from
# GET /api/public-config, so this image is environment-agnostic.
# NEXT_PUBLIC_API_URL defaults to a relative path (empty string) so requests
# go to the same origin — works behind the Next.js /api/* proxy rewrite.
# These build args are kept for backwards compatibility but are no longer
# required for a functional deployment.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# NEXT_PUBLIC_STELLAR_NETWORK is intentionally NOT set at build time.
# The runtime value is fetched from GET /api/public-config at startup.
# Setting it here would re-introduce the build-time bake-in problem.

COPY . .
RUN npm run build

# ── Stage 2: run ──────────────────────────────────────────────
# Re-declare ARG so the runner stage resolves the same image as the builder.
ARG NODE_VERSION=24
# node:20-alpine pinned to the same immutable manifest digest as the builder.
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

# Build metadata (#1634), supplied by .github/workflows/release.yml.
ARG APP_VERSION=""
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}
LABEL org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.revision=${GIT_SHA}

# Non-root user for security
RUN addgroup -S -g 1001 appgroup && adduser -S -u 1001 -G appgroup appuser

WORKDIR /app

# Copy only what Next.js needs to serve the built app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
