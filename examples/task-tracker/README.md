# Task Tracker Example

A full-stack reference application built and verified with the **Antigravity Software Factory** workflow.

## Architecture

| Service | Stack | Port (Host -> Container) | Description |
| :--- | :--- | :--- | :--- |
| `db` | PostgreSQL 16 (`postgres:16-alpine`) | `5432 -> 5432` | Initializes the `tasks` schema from `db/init.sql` with a persistent `pgdata` volume and readiness healthcheck. |
| `api` | Node.js 20 + Express + `pg` (`./api`) | `4000 -> 4000` | Parameterized REST API serving `/health` and CRUD routes under `/api/tasks`. |
| `web` | React 18 + Vite + Nginx (`./web`) | `3000 -> 80` | Responsive task tracker SPA served by Nginx, proxying `/api/*` and `/health` to `api:4000`. |

Environment defaults match `.env.example` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `API_PORT`, `WEB_PORT`) and work out of the box without creating a `.env` file.

## Running with Docker Compose

From `examples/task-tracker`:

```bash
# Build images and start db, api, and web in the background
docker compose up --build -d

# Check service status and health
docker compose ps
curl http://localhost:4000/health

# Open the web UI at http://localhost:3000
```

To stop and clean up containers:

```bash
docker compose down
# Add -v to also remove the pgdata Postgres volume:
# docker compose down -v
```

## Running Unit Tests

The `api` service includes `node:test` integration/route tests backed by a mock connection pool (no running database required):

```bash
cd api
npm install
npm test
```

## Running the Software Factory CLI

From `examples/task-tracker`, you can inspect, verify, and security-audit this project using the `agy-factory` CLI:

```bash
# 1. Detect project components, scripts, and Docker Compose topology
node ../../bin/agy-factory.js detect --cwd .

# 2. Run deterministic hygiene, Docker Compose config, test, and build checks
node ../../bin/agy-factory.js verify --cwd .

# 3. Run static diff & security audit across files
node ../../bin/agy-factory.js audit-diff --cwd . --all
```
