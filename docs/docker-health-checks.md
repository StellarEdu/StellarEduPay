# Docker Health Checks

## Overview

Health checks ensure that services start in the correct order and are fully ready before dependent services attempt to connect. This prevents startup crashes and race conditions in Docker environments.

## Implementation

### MongoDB Health Check

The MongoDB service uses `mongosh` to verify the database is accepting connections:

```yaml
healthcheck:
  test: ["CMD", "mongosh", "--eval", "db.runCommand({ ping: 1 })"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 10s
```

- Checks every 10 seconds
- Times out after 5 seconds
- Retries up to 5 times before marking as unhealthy
- Waits 10 seconds before starting checks (allows MongoDB to initialize)

### Backend Health Check

The backend service uses the `/health` endpoint which checks both database and Stellar connectivity:

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -f http://localhost:5000/health || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

- Checks every 10 seconds
- Times out after 5 seconds
- Retries up to 5 times before marking as unhealthy
- Waits 30 seconds before starting checks (allows Node.js app to start and connect to MongoDB)

`/health` is public, so its body is just `{ "status": "..." }` (Issue #1540);
the detailed per-dependency report is at `GET /api/admin/health/details`
(admin auth).

The `/health` endpoint returns a three-tier status, not a simple pass/fail:
- `200 OK` with `status: "healthy"` — database, Stellar, and other subsystems are all fine
- `200 OK` with `status: "degraded"` — MongoDB is up, but a non-critical subsystem (e.g. Stellar Horizon unreachable, Redis not ready, retry queue failed) is impaired; the app keeps serving traffic
- `503 Service Unavailable` with `status: "unhealthy"` — MongoDB is disconnected

A Horizon or Redis blip alone will never cause a 503 — only a MongoDB outage does.

### Service Dependencies

Services now use `condition: service_healthy` to ensure proper startup order:

```yaml
backend:
  depends_on:
    mongo:
      condition: service_healthy

frontend:
  depends_on:
    backend:
      condition: service_healthy

backup:
  depends_on:
    mongo:
      condition: service_healthy
```

## Startup Sequence

1. **MongoDB** starts and initializes
2. MongoDB health check passes (responds to ping)
3. **Backend** starts (MongoDB is ready)
4. Backend connects to MongoDB and Stellar
5. Backend health check passes
6. **Frontend** starts (backend is ready)
7. **Backup** service starts (MongoDB is ready)

## Usage

### Start with Health Check Waiting

```bash
docker-compose up --wait
```

This command will:
- Start all services
- Wait for all health checks to pass
- Exit with code 0 when all services are healthy
- Exit with non-zero code if any service fails health checks

### Check Service Health

```bash
# View health status of all services
docker-compose ps

# Check specific service health
docker inspect --format='{{.State.Health.Status}}' <container_name>

# View health check logs
docker inspect --format='{{json .State.Health}}' <container_name> | jq
```

### Manual Health Check Testing

```bash
# Test MongoDB health
docker-compose exec mongo mongosh --eval 'db.runCommand({ ping: 1 })'

# Test backend health
curl http://localhost:5000/health

# Expected response when healthy:
{
  "status": "healthy",
  "timestamp": "2024-03-30T10:00:00.000Z",
  "checks": {
    "database": {
      "status": "healthy",
      "latency_ms": 5
    },
    "stellar": {
      "status": "ok",
      "latency_ms": 150,
      "network": "testnet",
      "horizonUrl": "https://horizon-testnet.stellar.org"
    }
  }
}

# Example response when degraded (e.g. Horizon unreachable, MongoDB still up):
# HTTP 200, not 503 — the app keeps serving traffic
{
  "status": "degraded",
  "timestamp": "2024-03-30T10:00:00.000Z",
  "checks": {
    "database": {
      "status": "healthy",
      "latency_ms": 5
    },
    "stellar": {
      "status": "unreachable",
      "error": "Horizon did not respond within 3000ms",
      "network": "testnet",
      "horizonUrl": "https://horizon-testnet.stellar.org"
    }
  }
}
```

## Troubleshooting

### Backend Fails to Start

If the backend health check fails:

1. Check MongoDB is healthy: `docker-compose ps mongo`
2. View backend logs: `docker-compose logs backend`
3. Verify MongoDB connection: `docker-compose exec backend wget -qO- http://localhost:5000/health`

### MongoDB Health Check Fails

If MongoDB health check fails:

1. Check MongoDB logs: `docker-compose logs mongo`
2. Verify MongoDB is running: `docker-compose ps mongo`
3. Test manually: `docker-compose exec mongo mongosh --eval 'db.runCommand({ ping: 1 })'`

### Services Start Out of Order

If services start before dependencies are ready:

1. Verify `depends_on` uses `condition: service_healthy`
2. Check health check configuration (interval, retries, start_period)
3. Increase `start_period` if service needs more initialization time

## Health Check Parameters

- **interval**: Time between health checks
- **timeout**: Maximum time for a single check
- **retries**: Number of consecutive failures before marking unhealthy
- **start_period**: Grace period before health checks begin (allows initialization)

## Best Practices

1. Set `start_period` longer than typical startup time
2. Use reasonable `interval` values (10-30 seconds)
3. Keep `timeout` short (3-10 seconds)
4. Set `retries` to allow for transient failures (3-5)
5. Always use `condition: service_healthy` for critical dependencies
6. Test health checks locally before deploying

## CI/CD Integration

In CI/CD pipelines, use `--wait` to ensure services are ready:

```bash
# Start services and wait for health
docker-compose up -d --wait

# Run tests (services are guaranteed healthy)
npm test

# Cleanup
docker-compose down
```

## Production Considerations

- Health checks add overhead (CPU, network)
- Balance check frequency with resource usage
- Monitor health check failures in production
- Set up alerts for unhealthy services
- Consider using orchestration tools (Kubernetes, Docker Swarm) for advanced health management

## Monitoring Stack Prerequisites

Before launching the monitoring stack (`docker-compose.monitoring.yml`), the
following environment variables **must** be set:

| Variable | Description | How to generate |
|----------|-------------|-----------------|
| `GRAFANA_PASSWORD` | **Required.** Grafana admin password. No default — Docker Compose will refuse to start if unset. | `openssl rand -hex 24` |
| `METRICS_TOKEN` | **Required.** Bearer token for the `/metrics` endpoint. | `openssl rand -hex 32` |

```sh
# Set required variables before starting the monitoring stack
export GRAFANA_PASSWORD=$(openssl rand -hex 24)
export METRICS_TOKEN=$(openssl rand -hex 32)

# Create monitoring/secrets/metrics_token with the METRICS_BEARER_TOKEN value (see docker-compose.monitoring.yml)
# then start the stack:
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

If `GRAFANA_PASSWORD` is not set, Docker Compose will exit immediately with:
```
GRAFANA_PASSWORD: Error: GRAFANA_PASSWORD environment variable must be set.
```
