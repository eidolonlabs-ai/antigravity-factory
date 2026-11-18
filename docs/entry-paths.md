# Start a development task (`antigravity-factory`)

Install or link the plugin (`agy plugin install ./plugins/antigravity-factory` or `node bin/agy-factory.js init --mode link`), then run the 5-phase solo-developer loop natively in Antigravity (`factory-pipeline`, or invoke each stage skill individually).

> **Shift-Left Habit:** Long-running agents only succeed when requirements, edge cases, contracts, and adversarial tests are locked *before* implementation starts. If your prompt is underspecified, `factory-intake` will push back (`needs_clarification`) rather than guessing.

## 1. Choose Your Entry Point (Minimum Inputs & Pushback Triggers)

| Starting point | Minimum inputs required | When the factory pushes back (`needs_clarification`) | First milestone |
| --- | --- | --- | --- |
| **1. New / Greenfield App** | Intended users, core journeys, stack constraints, data/API expectations, and any handoff spec | Vague 1-liners, undefined entities/endpoints, or unresolved **4-Part State & Edge-Case Matrix** domains | Run `/grill-me` + `factory-architect` on the 4-Part Matrix, lock `SPEC.md`/contracts + Compose healthchecks, write **Milestone 1.5 Frozen Adversarial Tests**, and freeze `.factory/spec.json`. |
| **2. Existing / Brownfield Repo** | Repo path, concrete goal, coding conventions, test commands, and known baseline failures | Missing test scripts (`NOT_RUN`), unstated compatibility bounds, or unadopted `.factory.json` | Run `agy-factory detect`, adopt with `factory-setup`, establish baseline `agy-factory verify --require-tests`, and pin scoped slice boundaries. |
| **3. Bug Fix (Reproduce-First)** | Expected vs. actual behavior, reproduction steps, environment, and stack traces/logs | Missing reproduction steps or request to "just fix it" without a failing test | Write a failing regression test first (**Reproduce Before Fixing**), confirm failure, patch minimally in `factory-build` (`/boost` for race/state bugs), and re-verify full stack + `/browser`. |
| **4. Feature / Behavior Change** | Desired behavior, exemplar files, API/DB compatibility constraints, and failure handling | Unspecified schema migrations, missing error states, or ambiguous backward compatibility | Agree on interface/schema deltas and acceptance criteria in `factory-plan`, freeze adversarial tests, and split disjoint slices across `swarm` (`workspace: "share"`) workers if independent. |
| **5. Large-Scale Refactor / Migration** | Source/target patterns, invariant guarantees, rollout scope, and verification oracle | Missing baseline tests or overlapping multi-file edits without slice ownership | Capture baseline checks + frozen contract tests first, partition disjoint slices in `.factory/spec.json`, and run `/run-workflow` or parallel `swarm` worktrees landed via `agy-factory land`. |

## 2. How to Choose Which Skill / Stage to Invoke

Start with **`factory-pipeline`** whenever you want guided end-to-end orchestration (or when starting from a rough idea). Jump directly to a stage skill only when all prerequisites for that stage are already satisfied:

| Skill | Invoke directly when… | What happens if prerequisites are missing (Pushback) |
| --- | --- | --- |
| **`factory-pipeline`** | Default entry point for any full feature, greenfield build, bug fix, or refactor | Guides you through Phases 0–4 and refuses to skip intake/freeze on ambiguous tasks |
| **`factory-setup`** | Onboarding a new or existing repo (`agy-factory init`, `.factory.json`, `/tmp/*.log` hygiene) | Reports missing test/Compose scripts (`NOT_RUN`) before letting work proceed |
| **`factory-intake`** | Evaluating a raw spec/handoff (`benchmarks/chronograph/input/original.md`) or scoping requirements before design | **Pushes back** one question at a time (`/grill-me` + `factory-architect`) on ambiguities and the 4-Part Matrix |
| **`factory-plan`** | Blocking intake questions are answered and you are ready to freeze `SPEC.md`, Compose healthchecks, Milestone 1.5 tests, and `.factory/spec.json` | **Refuses to freeze** while blocking intake decisions remain open or adversarial tests are missing |
| **`factory-build`** | Contracts, frozen tests, and disjoint slices are already locked (`/goal`, `/boost`, or `swarm` `workspace: "share"`) | **Halts and routes back** to `factory-intake` / `factory-plan` if non-trivial tasks lack frozen specs/tests |
| **`factory-verify`** | Checking a built candidate with `agy-factory verify --require-tests` + `/browser` E2E | Fails closed if tests are `NOT_RUN`, receipt is stale, or live UI throws console/network errors |
| **`factory-review`** | Fresh-context security & code review (`agy-factory audit-diff` + `factory-reviewer`) on a verified candidate | Blocks approval if verification receipt is stale or defects lack failing regression tests (**Reproduce Before Fixing**) |
| **`factory-status`** | Inspecting `.factory/verify-receipt.json` freshness, browser/review evidence digests, or stop-gate state | Reports `UNVERIFIED` / `EXHAUSTED` honestly—never treats stop-hook exhaustion as pass |
