---
name: factory-pipeline
description: >-
  Orchestrates the 4-stage Antigravity Harness workflow end-to-end across
  Antigravity: spec & slice planning,
  isolated parallel swarm or git worktree execution, deterministic QA + live
  browser/E2E verification, and diff security review. Use this skill when
  building features, full-stack apps, services, or multi-file refactors from
  start to finish.
---

# Harness Pipeline Orchestrator

Run software delivery as a disciplined **4-stage Antigravity Harness workflow** combining probabilistic multi-agent execution with deterministic CLI gates. Never collapse planning, parallel authoring, verification, and security review into an unverified single-pass edit.

## Locating the `agy-factory` CLI

Resolve the `agy-factory` binary once at the start of the pipeline using the first path that exists:

1. **Workspace binary / npm link**: `npx --no-install agy-factory` or `node ./bin/agy-factory.js`
2. **Copied workspace plugin**: `node ./.agents/plugins/antigravity-harness/bin/agy-factory.js`
3. **Bundled relative to this skill**: `node <plugin-dir>/bin/agy-factory.js` (i.e. [agy-factory.js](../../bin/agy-factory.js), two directories up from `skills/factory-pipeline/`—works from `~/.gemini/config/plugins/antigravity-harness/bin/agy-factory.js` or any linked plugin path)

Set `FACTORY_CLI` in commands below to whichever path resolved.

---

## Stage 1: Specification & Disjoint Ownership (`factory-spec-planner`)

Follow [factory-spec-planner](../factory-spec-planner/SKILL.md) before touching application code:

1. **Inventory the stack**:
   ```bash
   $FACTORY_CLI detect --cwd . --json
   ```
2. **Lock shared contracts upfront**: Define database schemas, REST/RPC endpoints, request/response shapes, environment variables (`.env.example`), and shared types before spawning builders so workers never guess interfaces.
3. **Define acceptance criteria**: Write concrete, testable functional and error-handling criteria.
4. **Publish a Slice Ownership Table**: Partition work into slices with **strictly disjoint** `Owned Files`, explicit `Forbidden Files`, and a per-slice `Verification Command`. If a task touches only 1–2 tightly coupled files, keep a single slice and skip swarm fan-out in Stage 2.

---

## Stage 2: Isolated Parallel Swarm / Worktree Build

When Stage 1 yields multiple independent slices, execute them in isolated git worktrees with mechanical boundary enforcement:

1. **Spawn isolated builders**:
   - **In Antigravity (`swarm`)**: Add one worker per slice with `workspace: "share"` so each builder operates in its own isolated git worktree:
     ```text
     swarm{
       action: "add",
       name: "<slice-name>",
       workspace: "share",
       brief: "You own ONLY: <Owned Files>. Do NOT touch: <Forbidden Files>. Shared contracts: <Contracts>. Implement <Spec>, verify with `<Verification Command>`, and run `$FACTORY_CLI audit-diff --cwd . --allow-paths \"<Owned Files>\"` to prove slice boundary compliance. Report files changed and command output to @coordinator."
     }
     ```
2. **Spawn an independent verifier**: Add a read-only `verifier` worker (`workspace: "inherit"` in Antigravity) tasked with executing Stage 3 and Stage 4 once slices land, or run Stages 3–4 directly after integrating all slices.
3. **Wait & integrate cleanly**: In Antigravity, sleep via `swarm_wait` (never poll). As each builder reports green slice checks, audit and land its worktree using `$FACTORY_CLI land --worktree <worktree> --slice <slice-name>` (or `--allow-paths "<Owned Files>"`), verify zero cross-slice file overlap, and clean up the worker (`swarm{action: "kill", name: "<slice-name>"}` or `git worktree remove ../wt-<slice-name>`).

---

## Stage 3: Deterministic QA & Browser Verification (`factory-qa-verifier`)

Follow [factory-qa-verifier](../factory-qa-verifier/SKILL.md) on the integrated workspace:

1. **Run deterministic verification**:
   ```bash
   $FACTORY_CLI verify --cwd . --require-tests
   ```
2. **Audit check states & receipt**:
   - Confirm `.factory/verify-receipt.json` exists with `"ok": true`.
   - Inspect every check (`hygiene`, `docker-compose`, `lint`, `typecheck`, `test`, `build`).
   - **Never treat `NOT_RUN` as `PASS`**. If runnable unit/integration tests are missing (`NOT_RUN`), author or wire tests before proceeding.
3. **Live UI verification (web apps)**:
   - Start the local dev server or Docker Compose stack (`docker compose up --build -d`), confirm health endpoints respond, and exercise end-to-end user flows (create, update, filter, delete, error states) and verify zero console/network errors using the `browser` subagent (Antigravity).

---

## Stage 4: Diff Audit & Semantic Security Review (`factory-security-reviewer`)

Follow [factory-security-reviewer](../factory-security-reviewer/SKILL.md) as a **strictly read-only** gate:

1. **Run deterministic diff scan**:
   ```bash
   $FACTORY_CLI audit-diff --cwd .
   ```
2. **Perform independent semantic review**: Inspect `git status --short` and `git diff` for parameterized queries, input validation, auth boundaries, XSS safety, error handling, secret hygiene, and preserved documentation.
3. **Gate on verdict**:
   - **`CHANGES REQUESTED`**: Route exact `file:line` findings back to the owning builder (or apply minimal targeted fixes), then **re-run Stage 3 and Stage 4** so `.factory/verify-receipt.json` matches the final workspace digest.
   - **`APPROVE`**: Summarize delivered slices, verification receipt results, browser QA coverage, and security review sign-off for the user.

## Completion and native ownership

Use Antigravity's native delegation, browser and permission mechanisms; do not implement a second agent runner. Before landing, run harness verification in each worker and retain a fresh receipt. Landing checks conflicts and verifies the integrated state; it does not commit or push. Review the combined diff after integration.

Finish with `$FACTORY_CLI status --cwd . --json`. Report configured mechanical status separately from independent review and live UI coverage. For a session exhausted by stop reminders, report the unfinished requirements; never describe termination as success. Missing or stale required evidence needs actual reinspection, not an invented record.
