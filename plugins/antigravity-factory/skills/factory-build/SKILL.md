---
name: factory-build
description: >-
  Phase 3 isolated execution in Antigravity Factory. Verifies locked specs and
  Milestone 1.5 frozen tests exist first (routing back to intake/plan if missing),
  then runs sequential (`/goal`, `/boost`) or parallel `swarm` worktree builds
  (`workspace: "share"`), `/teamwork`, or `/run-workflow`, landing with `agy-factory land`.
---

# Factory Build (Phase 3)

Implement approved slices inside isolated boundaries using Antigravity's native execution primitives (`factory-builder` agent in `../../agents/factory-builder.md`). Resolve `FACTORY_CLI` once (`node ./bin/agy-factory.js`, `node ./.agents/plugins/antigravity-factory/bin/agy-factory.js`, or `node <plugin-dir>/bin/agy-factory.js`) and substitute the resolved path into worker briefs.

## Pre-Flight Spec & Test Check (Pushback Gate)

Before editing application code on any non-trivial feature, app, bug fix, or refactor:
1. Confirm an approved specification (`SPEC.md` or resolved intake decisions), disjoint `Owned Files` / `.factory/spec.json` slices, and failing **Milestone 1.5 Frozen Adversarial Tests** (or a failing reproduction test for bug fixes) already exist.
2. If the request jumped straight to coding without resolved requirements or failing tests, **stop and route back** to `factory-intake` / `factory-plan` instead of guessing implementation details.

## Execution Mode Selection

- **Small / sequential task (single slice)**: Work in one agent using `/goal` (or `/boost` for subtle race conditions / state-engine bugs) without spawning unnecessary swarm workers.
- **Independent multi-slice task**: Spawn one `factory-builder` worker per slice via Antigravity `swarm` with `workspace: "share"` (or `/teamwork`, or `/run-workflow` for large scripted migrations):

```text
swarm{
  action: "add",
  name: "<slice-name>",
  workspace: "share",
  brief: "Role: factory-builder. You own ONLY: <Owned Files>. Do NOT touch: <Forbidden Files>, holdout/**, or .factory/**. Shared contracts: <Contracts>. Redirect verbose logs to /tmp/*.log. Run `<Verification Command>`, `$FACTORY_CLI verify --cwd . --require-tests`, and `$FACTORY_CLI audit-diff --cwd . --allow-paths \"<Owned Files>\"`. Report changed files and command results to @coordinator."
}
```

Wait reactively (never poll in a loop).

## Builder Rules

1. **Disjoint Ownership**: Never assign two concurrent workers to edit the same file. Enforce slice scope via `FACTORY_SLICE=<slice>` and `pre-tool-guard.js`.
2. **Do Not Weaken Tests**: Never modify frozen tests, `holdout/**`, or verification config to make a check pass.
3. **Bounded Repair Loop**: After 3 failed repair attempts on a slice, stop and report the exact failure logs to the coordinator/owner for a scope or contract decision.
4. **Context Hygiene**: Route heavy test/build logs to `/tmp/<slice>.log` and inspect only the tail (`tail -n 50 /tmp/<slice>.log`).

## Landing Verified Worktrees

Before landing each completed slice into the integration workspace:
1. Confirm the worker ran `$FACTORY_CLI verify --cwd <worktree> --require-tests` and has a fresh passing `.factory/verify-receipt.json`.
2. Audit and land with `$FACTORY_CLI land`:
   ```bash
   $FACTORY_CLI land --worktree <worker-dir> --cwd . --slice <slice-name> --json
   ```
3. Clean up the worker (`swarm{action: "kill", name: "<slice-name>"}` or remove temporary worktree) only after landing succeeds.
4. Never commit or push automatically; proceed to `factory-verify` and `factory-review` on the combined candidate.
