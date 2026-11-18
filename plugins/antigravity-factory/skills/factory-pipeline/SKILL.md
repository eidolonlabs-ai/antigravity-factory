---
name: factory-pipeline
description: >-
  End-to-end 5-phase Antigravity Factory orchestrator that shifts work upfront—
  pushing back on underspecified requests during read-only intake, locking
  contracts and Milestone 1.5 frozen adversarial tests before implementation,
  then running isolated single/parallel swarm worktrees, QA + browser checks,
  cold-context review, and status reporting.
---

# Factory Pipeline Orchestrator

Orchestrate solo-developer multi-agent software delivery across five disciplined phases combining probabilistic Antigravity workflows (`/grill-me`, `/plan`, `/goal`, `swarm`, `/teamwork`, `/run-workflow`, `/boost`, `browser`) with deterministic `agy-factory` CLI gates and hooks.

## Locating the `agy-factory` CLI

Resolve `FACTORY_CLI` once at the start of the pipeline using the first path that exists:

1. **Workspace binary / npm link**: `npx --no-install agy-factory` or `node ./bin/agy-factory.js`
2. **Copied workspace plugin**: `node ./.agents/plugins/antigravity-factory/bin/agy-factory.js`
3. **Bundled relative to this skill**: `node <plugin-dir>/bin/agy-factory.js` (two directories up from `skills/factory-pipeline/`)

---

## Shift-Left Gate

Do **not** enter Phase 3 (`factory-build`) for non-trivial work until:
- Phase 1 (`factory-intake`) has pushed back on all ambiguities and resolved blocking questions (including the **4-Part State & Edge-Case Matrix**) in writing.
- Phase 2 (`factory-plan`) has locked `SPEC.md`/contracts, Compose healthchecks, disjoint `.factory/spec.json` slices, and failing **Milestone 1.5 Frozen Adversarial Tests** (or a failing reproduction test for bug fixes).

## Phase 0: Workspace Setup (`factory-setup`)

Follow [factory-setup](../factory-setup/SKILL.md):
- Adopt or verify `.factory.json` and plugin hooks (`$FACTORY_CLI init` + `$FACTORY_CLI detect --cwd . --json`).
- Enforce context hygiene: redirect verbose build/test output to `/tmp/*.log` and inspect only the tail on failures.

## Phase 1: Intake & Edge-Case Interview (`factory-intake`)

Follow [factory-intake](../factory-intake/SKILL.md):
- Route the request by entry point (**New Project**, **Existing Repo**, **Bug Fix [Reproduce-First]**, **Feature/Behavior Change**, or **Refactor/Migration**).
- Run a **read-only** `factory-architect` pass (Plan Mode or `research` subagent) paired with `/grill-me` (one question at a time) probing the **4-Part State & Edge-Case Matrix**:
  1. Out-of-order & duplicate inputs (`X-Idempotency-Key`, replay guards)
  2. Concurrency & race conditions (DB row locks `FOR UPDATE`, UI `AbortController`, monotonic counters)
  3. Clock & timezone boundaries (UTC ISO-8601 at rest, explicit `as_of` cursors vs `now()`)
  4. Dual-write & cross-service atomicity (commit ordering, stale edge deletion before `MERGE`/upsert)
- Stop before implementation while blocking ambiguities remain.

## Phase 2: Contracts, Frozen Tests & Slice Plan (`factory-plan`)

Follow [factory-plan](../factory-plan/SKILL.md):
- Lock `SPEC.md`, API/DB contracts, `.env.example`, and `docker-compose.yml` with realistic service `healthcheck` definitions.
- Write **Milestone 1.5 Frozen Adversarial Tests** (happy paths + all 4 edge-case matrix failures, protected under `holdout/` or frozen test paths) and confirm they fail as expected before implementation.
- Partition multi-file builds into strictly disjoint slices in `.factory/spec.json` (`$FACTORY_CLI plan --init`). For 1–2 tightly coupled files, keep a single slice.

## Phase 3: Isolated Execution (`factory-build`)

Follow [factory-build](../factory-build/SKILL.md):
- **Single-slice / linear milestones**: Build directly in one agent using `/goal` (or `/boost` for tricky state/race bugs).
- **Independent multi-slice builds**: Fan out `factory-builder` workers via Antigravity `swarm` with `workspace: "share"` (one worktree per slice, `FACTORY_SLICE=<slice>`), `/teamwork`, or `/run-workflow` (never assign concurrent writers to the same file).
- Audit and integrate finished slices with `$FACTORY_CLI land --worktree <dir> --slice <slice>` before cleanup (`swarm{action: "kill", ...}`).

## Phase 4: Verification, Review & Handoff

1. **QA & Live Browser Gate ([factory-verify](../factory-verify/SKILL.md))**:
   - Run `$FACTORY_CLI verify --cwd . --require-tests` (`NOT_RUN` is never `PASS`).
   - Confirm `.factory/verify-receipt.json` has `"ok": true`.
   - When a web UI exists, boot the real stack, exercise live E2E flows via the `browser` subagent (`/browser`), confirm zero console/network errors, and record observed evidence (`$FACTORY_CLI evidence record --kind browser ...`).
2. **Cold-Context Security & Code Review ([factory-review](../factory-review/SKILL.md))**:
   - Capture `subjectDigest` and `policyDigest` from `$FACTORY_CLI status --cwd . --json`.
   - Run `$FACTORY_CLI audit-diff --cwd .` and dispatch a fresh read-only `factory-reviewer` (`research` subagent) over `git diff`.
   - Enforce **Reproduce Before Fixing**: write a failing regression test confirming any bug before applying a minimal patch, then re-run `factory-verify`.
   - Record independent review outcome (`$FACTORY_CLI evidence record --kind review ...`).
3. **Final Status & Delivery ([factory-status](../factory-status/SKILL.md))**:
   - Run `$FACTORY_CLI status --cwd . --json` and present configured gate status separately from independent review and live browser coverage. Never describe stop-hook budget exhaustion as completion.
