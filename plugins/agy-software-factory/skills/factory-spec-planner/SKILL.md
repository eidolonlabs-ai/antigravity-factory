---
name: factory-spec-planner
description: >-
  Inventories a repository with `agy-factory detect`, defines measurable
  acceptance criteria and shared data/API contracts, and produces a conflict-free
  Slice Ownership table (`.factory/spec.json`). Use this skill before multi-file
  edits or parallel swarm/worktree builds.
---

# Factory Spec & Ownership Planner

Convert user requirements into a deterministic, conflict-free engineering specification **before** any builder edits application files.

## Step 1: Inventory the Repository Deterministically

Run `agy-factory detect` first so your plan reflects the real stack, service boundaries, and runnable scripts rather than guesswork:

```bash
node ./bin/agy-factory.js detect --cwd . --json
# Or via plugin binary: node <plugin-dir>/bin/agy-factory.js detect --cwd . --json
```

Inspect the JSON output for:
- `hasDockerCompose` and `dockerComposeFile` (multi-container orchestration).
- `components[]`: each detected service/package (`node`, `python`, `go`, `rust`), its `relPath`, configured `scripts`, and runnable `commands` (`lint`, `typecheck`, `test`, `build`).
- Gaps in verification coverage (e.g., a component missing a `test` script that a slice must add).

## Step 2: Clarify Ambiguities & Lock Shared Contracts

If core product behavior is ambiguous, ask focused questions upfront (or recommend `/grill-me`). Then write down exact **Shared Contracts** that every slice will build against without cross-worker negotiation:

- **Data & Schema Contracts**: Table/collection definitions, column types, constraints, and defaults.
- **API Contracts**: HTTP method, route path, query/body validation rules, status codes (`200`, `201`, `400`, `404`, `500`), and exact JSON response shapes.
- **Environment & Runtime Contracts**: Variable names, safe local defaults in `.env.example`, internal vs. host ports, and proxy routes.

## Step 3: Define Measurable Acceptance Criteria

List concise, verifiable acceptance criteria covering:
1. Happy-path user/API workflows.
2. Input validation, edge cases, and error responses.
3. Required unit/integration tests and build artifacts.

## Step 4: Emit the Disjoint Slice Ownership Table

Partition implementation into independent slices and output a Markdown **Slice Ownership Table** with these exact four columns:

| Slice | Owned Files | Forbidden Files | Verification Command |
| :--- | :--- | :--- | :--- |
| `infra` | `docker-compose.yml`, `.env.example`, `db/init.sql`, `.gitignore` | `api/**`, `web/**` | `docker compose config --quiet` |
| `api` | `api/**` | `docker-compose.yml`, `db/**`, `web/**` | `cd api && npm test` |
| `web` | `web/**` | `docker-compose.yml`, `db/**`, `api/**` | `cd web && npm run build` |

### Ownership Invariants (Mandatory)

- **Pairwise Disjointness**: No file or glob may appear in `Owned Files` for more than one parallel slice.
- **Shared Root Files Have One Owner**: Files like `package.json`, `docker-compose.yml`, `.gitignore`, or shared schema files belong to exactly **one** slice (or are landed by the coordinator in Stage 1 before fan-out).
- **Executable Slice Verification**: Every slice must have a fast, deterministic `Verification Command` the owning worker runs in its `workspace: "share"` worktree before reporting completion.
- **Machine-Readable Spec (`.factory/spec.json`)**: Optionally persist or validate the slice table with `node ./bin/agy-factory.js plan --init` and `node ./bin/agy-factory.js plan` so `PreToolUse` (`FACTORY_SLICE=<slice>`), `audit-diff --slice <slice>`, and `land --slice <slice>` enforce slice boundaries automatically.
