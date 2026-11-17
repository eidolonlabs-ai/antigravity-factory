# Local Antigravity Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use a dedicated read-only reviewer at the review gates.

**Goal:** Ship a locally useful Antigravity plugin with honest verification gates, safe integration, and a tested repository-to-Marketplace packaging path.

**Architecture:** Keep one self-contained plugin bundle and delegate agent execution to Antigravity. Extend the deterministic CLI with versioned verification policy, freshness-bound evidence, and status. Build distribution artifacts from the same bundle; external factories later consume the CLI.

**Tech Stack:** Node.js 20+ ESM built-ins, node:test, Git, native Antigravity plugins; example-only PostgreSQL and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-local-antigravity-harness-design.md`

## Execution record — 2026-11-17

The implementation was completed sequentially in `codex/local-antigravity-harness`, with independent read-only milestone and final semantic/security reviews. The detailed checklists below preserve the original planned procedures; they are not a claim that every proposed test case or host qualification was executed verbatim. The table and [implementation status](../../implementation-status.md) record the delivered scope and observed checks.

| Task | Delivered status |
| --- | --- |
| 1. Native compatibility | Loader validation and documentation-derived hook fixtures complete; authenticated lifecycle and nested GitHub discovery remain unqualified |
| 2. Policy and freshness | Implemented and regression-tested, including staged index, large files and symlink target text |
| 3. Evidence and status | Implemented; evidence/status coverage consolidated in `tests/evidence.test.js` |
| 4. Stop reminders | Implemented and subprocess-tested; real host continuation/exhaustion qualification remains outstanding |
| 5. Landing | Conflict checks, integrated verification, rollback/recovery and human diagnostics implemented and reviewed |
| 6. Packaging and setup | Safe copy upgrades, archive/checksums, isolated read-only smoke and native strict validation complete; no publication |
| 7. Full-stack acceptance | Real PostgreSQL/API/browser checks passed; fixed the database idle-error crash discovered during testing |
| 8. Documentation and qualification | CLI contracts, skills, release instructions and local gates complete; authenticated install/discovery, logo inspection and Marketplace submission remain release work |

Implementation refinements include shared `workspace.js`, `records.js` and `install-copy.js` modules, a separate acceptance Compose file, and accessible-role browser selectors without UI changes. Plugin runtime remains Node built-ins only. The user subsequently authorized documentation updates, committing and pushing this feature branch; publication and merging to main are separate actions.

## Global Constraints

- Node.js 20+ built-in ESM modules only inside the factory plugin and root CLI; no external runtime dependencies.
- One canonical bundle: `plugins/agy-software-factory/`. It must work outside this repository and from a read-only installation directory.
- Antigravity only. Preserve native hook payloads and decisions, existing plugin registrations, optional Git hooks, and worktree/submodule resolution.
- Preserve existing comments and documentation unless directly invalidated.
- No implicit installation into the developer's live profile, publication, push, or Marketplace submission.
- Resolve restricted-PATH test companions across the executable directory and PATH, with npm_execpath fallback; never assume npm/git share Node's directory.

## Review Focus

- Host payload/version drift: normal completion must reach the reminder logic; cancellation and error termination must remain possible (Task 1 and 4).
- Freshness across commits, configuration changes, concurrent edits and non-Git projects: old or mismatched evidence cannot authorize completion (Task 2 and 3).
- Copy upgrades with user modifications or malformed registrations: no silent data loss, stale managed files, or source-checkout dependency (Task 6).
- Landing through symlinks or onto divergent target changes: preflight and rollback preserve unrelated work (Task 5).
- Packaging into read-only directories, paths with spaces, and native profile discovery: validation and actual execution must agree (Task 1, 6, and 8).

## Sequence and ownership

Execute sequentially with one implementation owner, followed by an independent read-only reviewer. No parallel builders are needed because CLI, receipt and hook contracts are coupled. If execution is parallelized later, split tasks into worktrees with disjoint ownership first and use `audit-diff --slice` plus `land`.

| Slice | Owned files | Forbidden files during its task | Verification |
| --- | --- | --- | --- |
| Compatibility | `docs/compatibility.md`, `tests/fixtures/antigravity/**`, `tests/compatibility.test.js` | Runtime implementation and other tests | `node --test tests/compatibility.test.js` |
| Policy and status | `lib/policy.js`, `lib/evidence.js`, `lib/status.js`, `lib/verify.js`, `lib/formatters.js`, plugin CLI, dedicated policy/evidence/status tests (paths under plugin unless noted) | Installer, land, hooks, example | Targeted tests then full suite |
| Stop | `bin/stop-verify-gate.js`, `tests/hooks.test.js` | Policy ownership files, installer, land | `node --test tests/hooks.test.js` |
| Landing | `lib/land.js`, `tests/land.test.js` | Installer, hooks, example | `node --test tests/land.test.js` |
| Packaging | `lib/init.js`, plugin metadata/README/LICENSE, `scripts/package-plugin.js`, `scripts/smoke-plugin.js`, `tests/distribution.test.js`, root package metadata and `.github/workflows/release.yml` | Policy, stop, landing implementation | Distribution tests and native validation |
| Reference app | `examples/task-tracker/**`, `tests/reference-app.test.js` | Factory runtime and other tests | Real DB integration and browser suite |
| Integration/docs | Existing CLI/tests when adaptation is needed, all four plugin skills, plugin rules, README, `docs/**`, `.github/workflows/ci.yml` | Unrelated application logic | All repository and host gates |

Table paths `lib/` and `bin/` are relative to `plugins/agy-software-factory/`; test paths are repository-relative. Shared CLI/documentation updates are sequential coordinator work, never concurrent ownership.

### Task 1: Qualify native host behavior and distribution discovery

**Files:** Create `docs/compatibility.md`, `tests/fixtures/antigravity/stop-model-stop.json`, `tests/fixtures/antigravity/stop-legacy.json`, `tests/compatibility.test.js`.

**Interfaces:** Produces documented payload fixtures and a supported install/activation procedure; no invented host flags or environment overrides.

- [ ] Record `agy --version`, strict bundle validation, current official plugin/hook references and exact tested surface.
- [ ] Add fixture assertions for normalized completion types, including `model_stop`, `NO_TOOL_CALL`, background activity, host errors and cancellation. Capture sanitized real payloads in a disposable host session when supported; mark documentation-derived fixtures separately.
- [ ] Exercise local install/list/discovery/hooks in an isolated profile using only a documented isolation mechanism. If profile isolation is unavailable, use a disposable environment; do not mutate the user's global install for a test.
- [ ] Test whether native GitHub installation discovers this repository's nested bundle. Record actual behavior; clone plus local installation is the mandatory fallback. Defer any test requiring a new public branch until publication is authorized.
- [ ] Review the compatibility report before implementing hook changes. Commit only these task files after review if execution includes commits.

### Task 2: Version policy and strengthen verification freshness

**Files:** Create `plugins/agy-software-factory/lib/policy.js`, `tests/policy.test.js`; modify `lib/verify.js`, `lib/formatters.js` and related CLI tests.

**Interfaces:** `loadFactoryPolicy(cwd) -> {schemaVersion, verification, stop, policyDigest}`; `runVerify(options)` retains existing fields and adds version/identity/policy fields. Required selectors use normalized component paths, not display names. Existing legacy configuration normalizes to equivalent behavior.

- [ ] Write tests: absent policy preserves baseline; malformed JSON/unknown schema fails; required missing or NOT_RUN check fails; required API and web checks cannot substitute for each other; duplicate custom IDs and escaping cwd are rejected; timeout defaults to 120000 and bounds are 1000–1800000; all custom commands are required; `providesEvidence` only accepts `browser`; artifact roots must be absolute existing directories.
- [ ] Run `node --test tests/policy.test.js` and verify the new expectations fail before implementation.
- [ ] Implement config normalization and exact required-check evaluation; add explicit custom commands with validated cwd/timeouts. Preserve optional detected checks and legacy `--require-tests` semantics.
- [ ] Add freshness regression tests for committed HEAD changes, policy/script changes, file edits during verification, stable generated output exclusion, and non-Git source changes. Hash subjects before/after command execution; changing subjects return nonpassing results.
- [ ] Run targeted tests, `npm test`, and independent read-only review. Version fields must not label unkeyed digests as signatures.

### Task 3: Record evidence and expose aggregate status

**Files:** Create plugin `lib/evidence.js`, `lib/status.js`, `tests/evidence.test.js`, `tests/status.test.js`; update plugin CLI and formatters.

**Interfaces:** `recordEvidence({cwd, kind, status, summary, producer, artifacts, expectedSubjectDigest, expectedPolicyDigest})` rejects state/policy mismatches and writes a schema-v1 record for the inspected subject/policy. `evaluateStatus({cwd, conversationId = null})` returns `{schemaVersion, outcome, reasons, subjectDigest, policyDigest, requiredChecks, evidence}`. Add `evidence record --kind browser|review --status PASS|FAIL --summary <text> --producer <text> [--artifact <path>] --subject-digest <digest> --policy-digest <digest>` and `status --json [--conversation <id>]`. Read status before starting a browser/review operation and pass its digests when recording results.

- [ ] Write tests for all four outcomes, missing/failed/stale evidence, invalid artifact paths, legacy receipts, policy changes, and evidence generated for another workspace. Add inspect-A/edit-to-B/record-A tests asserting B remains unverified. Test two concurrent conversations, new-conversation isolation and workspace-only diagnostics. Test default-policy landing may satisfy mechanical VERIFIED while workflow review is still outstanding, whereas a policy requiring `review` remains UNVERIFIED until a fresh review record exists. Status must not mutate files or spawn agents.
- [ ] Run `node --test tests/evidence.test.js tests/status.test.js` and confirm failing expectations.
- [ ] Implement record validation and aggregate evaluation. Passing fresh verification plus every required evidence item yields VERIFIED; fresh failures yield FAILED; missing/stale evidence yields UNVERIFIED; a selected exhausted conversation yields EXHAUSTED unless fresh requirements have all passed. Without a conversation selector, return workspace verification status and separate session diagnostics.
- [ ] Map explicit command-based browser checks in policy; host browser/review evidence remains attributed observational evidence, not automatic proof of independence. Define JSON schemas in documentation with command examples.
- [ ] Verify CLI exit codes (0 verified, 1 unmet gate, 2 usage/config error), backward-compatible existing output fields, and independent read-only review.

### Task 4: Make stop reminders compatible and outcomes honest

**Files:** Modify plugin `bin/stop-verify-gate.js`, `tests/hooks.test.js`; update compatibility fixtures only with observed evidence.

**Interfaces:** Consume `loadFactoryPolicy` and `evaluateStatus`. Pass the payload conversation ID to status. Persist bounded continuation state keyed by conversation plus workspace identity under `.factory/`, never the plugin root. Keep native JSON wire format and exit 0 for handled hook decisions.

- [ ] Add tests for default off, legacy opt-in, normal idle stops in both payload formats, retry limit 0–3, edits not resetting the session budget, passing evidence after exhaustion, conversation isolation, reset on VERIFIED, retention of the most recent 200 records, background work, cancellation and errors.
- [ ] Run `node --test tests/hooks.test.js` and confirm new failures.
- [ ] Replace digest-keyed reminder reset and execution-number assumptions with the specified policy and session counter. At budget exhaustion preserve incomplete status and permit termination. Never synthesize passing verification.
- [ ] Exercise real host continuation once and exhausted termination once in the disposable environment. If host behavior differs, revise compatibility documentation and avoid claiming strict enforcement.
- [ ] Run all hook tests and independent review of wire compatibility and fail-open host limitations.

### Task 5: Make landing conflict-aware and verifiable

**Files:** Modify plugin `lib/land.js`; create `tests/land.test.js`; update existing landing expectations in CLI/pipeline tests sequentially.

**Interfaces:** Extend `runLand` results with `conflicts`, `verification`, `rolledBack`, `rollbackConflicts`, and `requiresReview`; preserve existing result fields. Consume worker status for required deterministic checks, but not coordinator-level final review evidence. A pre-landing worker receipt must match its current subject/policy; missing evidence blocks a normal apply, while dry-run reports it without writes.

- [ ] Write tests for divergent committed target edits, dirty target edits/deletions, identical source/target content, out-of-slice deletes, target symlink parents, invalid Git bases, and all-or-nothing preflight.
- [ ] Add injected apply-failure and failing integrated-verification tests asserting restoration of affected bytes/modes and preservation of unrelated dirty files. Test target state changes between preflight and apply; abort rather than overwrite. Test an edit during failing verification: preserve the newer content, report a rollback conflict and retain recovery data. Test concurrent landers are rejected by an exclusive lock; clean lock files only when ownership is certain.
- [ ] Run `node --test tests/land.test.js` and confirm failures.
- [ ] Implement full-operation preflight, exclusive landing lock, staging/compare-before-restore rollback, and deterministic verification on the combined workspace. Rollback covers only lander mutations; document that arbitrary verification-command side effects cannot be transactionally reversed. Do not copy receipts from workers or commit automatically. Invalidate previous final review evidence when the integrated subject changes.
- [ ] Ensure `--force` never bypasses ownership/path/conflict safety. Clearly document any retained override for regex findings. Run landing/pipeline suites and independent security review.

### Task 6: Build the installable release bundle and safe setup

**Files:** Modify plugin `plugin.json`, `package.json`, `lib/init.js`, root `package.json`; create plugin `README.md`, `LICENSE`, `scripts/package-plugin.js`, `scripts/smoke-plugin.js`, `tests/distribution.test.js`, `.github/workflows/release.yml`.

**Interfaces:** `npm run package:plugin` creates `dist/agy-software-factory-<version>.tgz` and SHA-256 inventory from an allowlisted canonical bundle. Build tooling may use installed archive utilities after explicit availability checks; plugin runtime remains built-ins only. Output artifact and root package versions must agree with the manifest.

- [ ] Add tests for manifest fields/skill names, complete internal relative references, malformed registration preservation, repeat install idempotency, modified copy protection, removal of previously managed stale files, spaces in paths, and rollback on failed update.
- [ ] Run `node --test tests/distribution.test.js` and confirm failing new requirements.
- [ ] Add supported metadata, proposed display name `Software Factory`, plugin-local prerequisites/usage/license, and clear distinction between native plugin installation and project initialization. Preserve the plugin ID and Node-invoked bin paths.
- [ ] Implement a managed-file inventory for copy updates. On legacy installs without inventory, adopt only byte-identical source files; otherwise refuse replacement and provide a migration/backup path. Never silently replace malformed registries.
- [ ] Implement archive construction and extraction smoke tests outside the repository. Make the installed bundle read-only and run CLI/hook entrypoints against a disposable writable project. No runtime files may resolve back to the checkout.
- [ ] Validate the extracted artifact with native `agy plugin validate --strict --json`; fail release qualification if that tool is unavailable rather than report a pass. CI without host access may still run portable tests, but cannot claim native qualification.
- [ ] Build release artifacts in CI with least privileges. Keep release publication/Marketplace submission separate from build and require explicit release authorization.

### Task 7: Demonstrate real full-stack acceptance

**Files:** Add example `.factory.json`, `api/tests/integration.test.js`, `web/tests/tasks.spec.js`, `web/playwright.config.js`, `scripts/verify-stack.js`; modify example packages/lockfiles, compose file, README and UI only where needed for stable selectors. Create `tests/reference-app.test.js` for configuration wiring.

**Interfaces:** Example policy requires API tests, web build, and explicit live-stack command. Real integration/browser suites are opt-in through dedicated scripts; the default fast unit test command remains deterministic without a database.

- [ ] Write integration tests against disposable PostgreSQL for CRUD, validation and persistence. Write browser tests for create/toggle/filter/delete, reload persistence, API errors and console/network errors; use unique stable selectors where needed.
- [ ] Run new suites against the unmodified example and identify genuine gaps before making minimal application changes. Do not add unrelated idempotency/outbox requirements to basic CRUD.
- [ ] Implement startup/readiness/cleanup with a unique Compose project name, bounded waits, no collision with user services, and failure artifacts retained under the example's `.factory/` directory.
- [ ] Run the complete live suite and prove it fails when the database or API is unavailable. Missing Docker/browser prerequisites produce explicit failure/NOT_RUN, never success for required acceptance.
- [ ] Perform live UI checks and independent diff/security review. Example dependencies must not enter the plugin bundle.

### Task 8: Align skills, documentation, and release qualification

**Files:** Modify root README, plugin README, all four plugin skills, plugin rules, `.github/workflows/ci.yml`; create `docs/release.md` and `docs/verification-contract.md`.

**Interfaces:** Documentation consumes the final implemented CLI/schema; skills call native Antigravity capabilities and deterministic commands without introducing a custom agent scheduler.

- [ ] Document a short solo-developer path: install, initialize project, plan, build with native delegation if useful, verify, independently review, inspect status. Explain optional stronger project policy.
- [ ] Label each capability as deterministic enforcement, agent workflow, or host-provided. Replace claims of sealed tests, signed receipts, unconditional success barriers, and autonomous orchestration that exceed implementation.
- [ ] Update QA/review skills to record evidence only after actual checks, recheck freshness after fixes, and report exhausted work as incomplete. Keep global rules from forcing multi-agent overhead on trivial tasks.
- [ ] Publish exact verified repository install instructions. If direct GitHub layout discovery failed, document clone/local-install and the generated distribution-tree option. Prepare Marketplace metadata and checklist without submitting.
- [ ] Run `npm test`, `node bin/agy-factory.js verify --require-tests`, `node bin/agy-factory.js audit-diff`, extracted-bundle smoke tests, native strict validation, and reference-app live tests. Capture results/versions and any unverified host surface honestly.
- [ ] Obtain a final independent read-only semantic/security review of the entire implementation diff. Resolve findings and rerun affected gates before completion.
- [ ] If later authorized to push `origin/main`, watch GitHub Actions with `gh run watch --exit-status` and inspect runner annotations with `gh run view`. Artifact readiness does not imply Marketplace acceptance.

## Delivery boundaries

The first reviewable milestone is native compatibility qualification plus versioned policy/status (Tasks 1–3). The second is safe stop/integration and an installable artifact (Tasks 4–6). The final milestone is live full-stack demonstration and release documentation (Tasks 7–8). No milestone claims features scheduled for a later one.

Planning deliverables change documentation only. Runtime implementation begins after the requested plan is reviewed. Recommended execution: one native implementation owner working sequentially, with independent read-only review at milestones; use isolated worktrees only if later parallel work has disjoint ownership.
