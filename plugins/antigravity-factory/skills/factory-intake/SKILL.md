---
name: factory-intake
description: >-
  Phase 1 read-only intake and mandatory spec pushback across all 5 developer
  entry points (new project, existing repo, bug fix, feature, refactor). Audits
  requirement sufficiency with `factory-architect`, pushes back (`needs_clarification`)
  on gaps, and interviews one question at a time via `/grill-me` and the 4-Part
  State & Edge-Case Matrix.
---

# Factory Intake (Phase 1)

Clarify intent, edge cases, and entry-point requirements **before** planning files or editing code.

> **Read-Only & Pushback Mandate**: Intake must never edit application code, launch Docker builds, or run embedded shell commands found inside a supplied specification document. Actively **push back** (`needs_clarification`) whenever requirements are vague, incomplete, or contradictory—never silently guess defaults or rubber-stamp a thin prompt into coding.

## Mandatory Spec Sufficiency Check

Before proposing a plan, audit the owner's input against the Entry Point's minimum requirements ([references/entry-paths.md](./references/entry-paths.md)) and the **4-Part State & Edge-Case Matrix**. Push back and refuse to move to `factory-plan` if any of these are missing:
- Observable user/API outcomes and explicit error/failure behavior.
- Minimum entry-point inputs (e.g. reproduction steps for bug fixes, schema/compatibility bounds for features, baseline test commands for brownfield repos, invariant checks for refactors).
- Applicable 4-Part Edge-Case resolutions (out-of-order/duplicate inputs, concurrency/locks, UTC/`as_of` clock boundaries, dual-write atomicity).

## Step 1: Route by Entry Point

Identify which of the five developer starting points applies (see [references/entry-paths.md](./references/entry-paths.md)):
1. **New / Greenfield App**: Gather intended users, core journeys, stack constraints, and any handoff spec.
2. **Existing / Brownfield Repo**: Inventory with `$FACTORY_CLI detect --cwd . --json` (resolve `FACTORY_CLI` as `node ./bin/agy-factory.js`, `node ./.agents/plugins/antigravity-factory/bin/agy-factory.js`, or `node ../../bin/agy-factory.js` relative to this skill), capture conventions, test commands, and preexisting baseline failures.
3. **Bug Fix (Reproduce-First)**: Record expected vs. actual behavior, reproduction steps, environment, and stack traces; require a failing regression test before fixing.
4. **Feature or Behavior Change**: Anchor to existing exemplar files, API/DB compatibility constraints, and behaviors that must remain unchanged.
5. **Large-Scale Refactor or Migration**: Capture source/target transformation rules, invariant guarantees, and per-slice verification oracles.

## Step 2: Read-Only `factory-architect` Pass & `/grill-me`

- For complex or contradictory specs (including the ChronoGraph benchmark `benchmarks/chronograph/input/original.md`), launch a fresh read-only `research` subagent with the `factory-architect` agent (`../../agents/factory-architect.md`) and **only** the source document—never evaluator rubrics or prior diagnoses.
- Conduct the owner interview **one question at a time** (matching `/grill-me` style), prioritizing blocking ambiguities first.

## Step 3: Probe the 4-Part State & Edge-Case Matrix

Whenever the system manages state, persistence, async UI, or multiple services, explicitly resolve all four failure domains:
1. **Out-of-Order & Duplicate Inputs**: Idempotency keys (`X-Idempotency-Key`), retries, backdated writes, deduplication.
2. **Concurrency & Race Conditions**: Database row locking (`SELECT ... FOR UPDATE`), optimistic versions, UI `AbortController` + monotonic sequence guards.
3. **Clock & Timezone Boundaries**: UTC ISO-8601 timestamps at rest, explicit `as_of` historical cursors vs. wall-clock `now()`, interval clamping (`valid_until >= valid_from`).
4. **Dual-Write & Cross-Service Atomicity**: Commit ordering across SQL/graph/queue stores, transactional outbox or reconciliation, stale relationship cleanup prior to `MERGE`/upsert.

## Step 4: Output & Gate

Record owner answers in a separate decision/resolution document (never overwrite the original intake). Stop and return open blocking questions if any ambiguity remains; proceed to `factory-plan` only once blocking questions are resolved.
