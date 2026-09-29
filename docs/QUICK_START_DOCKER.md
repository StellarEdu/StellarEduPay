# Quick Start with Docker

## Prerequisites

- Docker and Docker Compose installed
- `.env` file configured (copy from `.env.example`)

## Starting the Application

### Option 1: Start and Wait for Health Checks (Recommended)

```bash
docker-compose up --wait
```

This command will:
- Build and start all services
- Wait for MongoDB to be healthy
- Wait for backend to be healthy and connected
- Wait for frontend to be ready
- Exit when all services are healthy

### Option 2: Start in Detached Mode

```bash
docker-compose up -d
```

Then check health status:

```bash
docker-compose ps
```

## How the Frontend Reaches the API

The frontend image is built with `NEXT_PUBLIC_API_URL=/api` (same-origin) and
`BACKEND_PROXY_TARGET=http://backend:5000`. The browser only talks to
`http://localhost:3000`; Next.js proxies `/api/*` to the backend container, so
login, token refresh, the live payment stream (SSE) and CSV downloads all work
with first-party cookies and no extra configuration. Both values are build
args — rebuild the frontend (`docker-compose build frontend`) after changing
them. See [Frontend ↔ API Topologies](architecture.md#frontend--api-topologies)
for Kubernetes and cross-host setups.

## Verifying Services

### Check All Services

```bash
docker-compose ps
```

Expected output:
```
NAME                STATE               PORTS
mongo               Up (healthy)        27017/tcp
backend             Up (healthy)        5000/tcp
frontend            Up                  3000/tcp
backup              Up                  -
```

### Check Backend Health

```bash
curl http://localhost:5000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-03-30T10:00:00.000Z",
  "checks": {
    "database": {
      "status": "healthy",
      "latency_ms": 5
    },
    "stellar": {
      "status": "healthy",
      "latency_ms": 150
    }
  }
}
```

## Stopping Services

```bash
docker-compose down
```

To also remove volumes:

```bash
docker-compose down -v
```

## Viewing Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f mongo
docker-compose logs -f frontend
```

## Troubleshooting

### Backend Won't Start

1. Check MongoDB is healthy:
   ```bash
   docker-compose ps mongo
   ```

2. View backend logs:
   ```bash
   docker-compose logs backend
   ```

3. Verify environment variables in `.env`

### MongoDB Connection Issues

1. Check MongoDB logs:
   ```bash
   docker-compose logs mongo
   ```

2. Test MongoDB connection:
   ```bash
   docker-compose exec mongo mongosh --eval 'db.runCommand({ ping: 1 })'
   ```

### Rebuild After Changes

```bash
# Rebuild and restart
docker-compose up --build -d --wait

# Force rebuild without cache
docker-compose build --no-cache
docker-compose up -d --wait
```

## Development Workflow

1. Make code changes
2. Rebuild affected service:
   ```bash
   docker-compose up --build backend -d
   ```
3. Check logs:
   ```bash
   docker-compose logs -f backend
   ```

## Health Check Details

- **MongoDB**: Checks every 10s, healthy when responding to ping
- **Backend**: Checks every 10s, healthy when `/health` returns 200
- **Startup Order**: MongoDB → Backend → Frontend

See `docs/docker-health-checks.md` for detailed information.
