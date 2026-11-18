---
name: factory-plan
description: >-
  Phase 2 pre-build contract and test freeze gate (`agy-factory detect` +
  `agy-factory plan`). Pushes back if intake blockers remain, then locks
  `SPEC.md`, shared API/DB contracts, Docker Compose healthchecks, Milestone 1.5
  Frozen Adversarial Tests (`holdout/`), and conflict-free Slice Ownership in
  `.factory/spec.json`.
---

# Factory Plan & Contract Freeze (Phase 2)

Convert resolved intake decisions into frozen contracts, adversarial tests, and disjoint slice ownership **before** any builder edits application files.

> **Pre-Build Freeze Gate (Pushback Rule)**: Refuse to freeze `.factory/spec.json` or start `factory-build` if blocking intake questions remain open, if `SPEC.md` / Compose healthchecks are undefined, or if **Milestone 1.5 Frozen Adversarial Tests** (or bug reproduction tests) have not been written and observed failing before implementation.

## Step 1: Inventory the Repository Deterministically

```bash
$FACTORY_CLI detect --cwd . --json
```

Inspect `hasDockerCompose`, `dockerComposeFile`, and `components[]` (`node`, `python`, `go`, `rust`) plus missing `test`/`lint`/`typecheck`/`build` scripts.

## Step 2: Lock Shared Contracts (`SPEC.md`, OpenAPI, Compose)

Pair with Antigravity `/plan` to write concrete, unambiguous contracts:
- **`SPEC.md`**: Entities, state transitions, invariants, and edge-case resolutions from `factory-intake`.
- **Data & API Contracts**: Table/collection schemas, constraints, HTTP routes, request/response schemas, status codes, and `.env.example` defaults.
- **`docker-compose.yml`**: Real services (DB, API, web, E2E test service) with explicit `healthcheck` (`interval`, `timeout`, `retries`, `start_period`) and `condition: service_healthy`. Avoid fixed `container_name`, privileged mode, or Docker socket mounts in acceptance stacks.
- **E2E Testability**: Mandate explicit `data-testid` attributes on interactive UI elements and unique IDs on iterated rows (`data-testid="item-row-${id}"`).

## Step 3: Milestone 1.5 Frozen Adversarial Tests

Before writing implementation code:
1. Author failing unit, integration, and E2E tests covering both happy paths and all applicable **4-Part State & Edge-Case Matrix** scenarios.
2. Place hidden acceptance suites in `holdout/` (or `*.holdout.test.*`) where `pre-tool-guard.js` blocks builder edits. Note that holdout protection is a tool-write guardrail, not a process sandbox.
3. Verify that the new tests fail for the expected missing behavior prior to Phase 3.

## Step 4: Partition Disjoint Slices & Persist `.factory/spec.json`

Emit a Slice Ownership Table and persist `.factory/spec.json`:

```bash
$FACTORY_CLI plan --init --cwd .
$FACTORY_CLI plan --cwd . --json
```

| Slice | Owned Files | Forbidden Files | Verification Command |
| :--- | :--- | :--- | :--- |
| `infra` | `docker-compose.yml`, `.env.example`, `db/init.sql` | `api/**`, `web/**` | `docker compose config --quiet` |
| `api` | `api/**` | `docker-compose.yml`, `db/**`, `web/**` | `cd api && npm test` |
| `web` | `web/**` | `docker-compose.yml`, `db/**`, `api/**` | `cd web && npm run build` |

**Invariants**: Pairwise-disjoint `Owned Files`, single owner per root config file, executable per-slice `Verification Command`, and `FACTORY_SLICE=<slice>` enforcement during Phase 3. For 1–2 tightly coupled files, keep a single slice.
