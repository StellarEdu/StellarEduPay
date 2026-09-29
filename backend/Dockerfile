FROM node:20-alpine

# tini: init process for PID 1 — forwards signals to Node and reaps zombies
# node healthcheck: inline Node script replaces curl (smaller attack surface)
RUN apk add --no-cache tini

# Fixed UID/GID 1001 so runAsUser in K8s matches file ownership
RUN addgroup -S -g 1001 appgroup && adduser -S -u 1001 -G appgroup appuser

# Default to production so the app doesn't serve Swagger, skips insecure
# branches, and sets secure cookie flags even without an explicit override.
ENV NODE_ENV=production

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
