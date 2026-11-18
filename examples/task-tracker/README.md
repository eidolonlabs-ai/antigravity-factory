# Task Tracker Example

A full-stack reference application built and verified with the **Antigravity Factory** workflow.

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

## Running the Antigravity Factory CLI

From `examples/task-tracker`, you can inspect, verify, and security-audit this project using the `agy-factory` CLI:

```bash
# 1. Detect project components, scripts, and Docker Compose topology
node ../../bin/agy-factory.js detect --cwd .

# 2. Run deterministic hygiene, Docker Compose config, test, and build checks
node ../../bin/agy-factory.js verify --cwd .

# 3. Run static diff & security audit across files
node ../../bin/agy-factory.js audit-diff --cwd . --all
```

## Real database and browser acceptance

Install API and web dependencies (`npm ci` in each directory), then run `npx playwright install chromium` in `web/`. From the example directory run `node scripts/verify-stack.js`. Docker/Compose and Chromium are required; missing prerequisites fail, never silently pass.

The runner creates a unique Compose project with random loopback-only ports, checks readiness, executes PostgreSQL-backed API tests and Playwright user flows, proves health fails when the database stops, then removes its containers. It does not touch the normal development Compose stack. Logs and failure traces/screenshots are retained under `.factory/factory-*/`; browser artifacts have their own subdirectory. On abnormal process termination, inspect the project name and remove only that project with the acceptance Compose file.

The example `.factory.json` requires API tests, web build and this live-stack check. `agy-factory verify --cwd examples/task-tracker --require-tests` therefore runs the full acceptance flow. Fast unit tests remain `npm test` in `api/`. Browser-only tests expect `WEB_BASE_URL`; API integration tests expect `API_BASE_URL` and `DATABASE_URL`, supplied by the runner.
