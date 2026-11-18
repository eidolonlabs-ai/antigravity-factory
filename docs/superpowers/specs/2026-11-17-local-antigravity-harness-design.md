# Local Antigravity Harness Design

Status: proposed design accompanying the requested implementation plan. No runtime changes or publication are authorized by this document alone.

## Intent

Serve a solo developer working locally in Antigravity. Provide portable workflow skills, repository guardrails, deterministic verification, and evidence that can later be consumed by a larger team factory. Use Antigravity's native delegation, browser, model selection, permissions, and plugin lifecycle. Do not build a competing agent runner.

The user approved this direction in conversation and requested a plan plus repository and Marketplace packaging. Specific interfaces and defaults below are proposals, not previously approved requirements.

## Scope and constraints

- Node.js 20+ built-in ESM modules only inside the factory plugin and root CLI; no external runtime dependencies.
- One canonical bundle: `plugins/antigravity-harness/`. It must work outside this repository and from a read-only installation directory.
- Antigravity only. Preserve native hook payloads and decisions, existing plugin registrations, optional Git hooks, and worktree/submodule resolution.
- Preserve existing comments and documentation unless directly invalidated.
- No Jira intake, persistent job scheduler, remote execution fleet, automatic PR merging, DORA telemetry, cross-platform adapters, or new MCP server in this release.
- Protected acceptance tests are not advertised as hidden or sealed. Local receipts and review attestations are evidence, not cryptographic proof against a malicious process running as the user.
- Do not change host execution permissions or enable unrestricted execution automatically.

## Approaches

1. Harden the current plugin and expose stable CLI contracts (recommended): preserves working architecture and native host capabilities, with the smallest local operational burden.
2. Add a daemon and scheduler: introduces process lifecycle, persistence, and cost controls that belong to a later team factory; excluded.
3. Reduce the plugin to skills only: simpler packaging, but loses mechanical verification and ownership checks; excluded.

Use approach 1 as the plan's proposed implementation direction. Keep the nested canonical bundle. Support clone-and-local-install immediately; qualify direct GitHub installation against the actual host before documenting a one-command URL for this repository layout.

## Local verification contract

Extend `.factory.json` with `schemaVersion: 1` and an optional `verification` object. Preserve legacy `requireTests` and `enforceStopVerify` configuration when the new keys are absent; malformed configuration fails with an actionable error rather than falling back to weaker policy.

`verification.requiredChecks` contains exact `{ component, category }` selectors against detected checks. Component is the normalized workspace-relative component path, including `.`. Category is `lint`, `typecheck`, `test`, or `build`. Each selector must resolve to a check with `PASS`; missing, skipped, and failed checks fail policy. `verification.commands` contains trusted project-authored `{ id, cwd, command, timeoutMs }` entries for integration or browser runners. IDs are unique; cwd remains within the workspace, including symlink resolution; timeouts are positive bounded integers. All configured commands are required. `timeoutMs` defaults to 120000 and must be an integer from 1000 through 1800000. Optional `providesEvidence: "browser"` explicitly maps a successful command to browser evidence; no other value is supported. `verification.artifactRoots` is an optional array of absolute existing directory paths whose resolved locations may contain evidence artifacts; the workspace is always allowed. Commands are local project code, not a security sandbox.

`verification.requiredEvidence` is an optional array of `browser` and/or `review`. Default is empty so headless CLI projects do not require browser tooling. Host browser checks and fresh-context reviews are performed by Antigravity and recorded separately. A successful command-based browser suite can satisfy browser evidence only when explicitly mapped in configuration; no inference from a test command name.

Versioned evidence records include kind, status (`PASS` or `FAIL`), workspace identity, subject digest, policy digest, timestamp, producer/source description, summary, and referenced artifact paths. Capture subject and policy digests from status before the review/browser operation. Store through an explicit `agy-factory evidence record` command after the operation, supplying both expected digests, not by editing receipts. Recording rejects a mismatch with current state, so a review of earlier code cannot approve later edits. Evidence references must exist inside the workspace or configured artifact root. Recording reports is an authorized tool operation; do not invent hook exemptions for arbitrary writes. Review independence is declared and checked in workflow, not proven by a caller-supplied producer string.

Add `agy-factory status --json [--conversation <id>]`: read-only aggregate outcome `VERIFIED`, `UNVERIFIED`, `FAILED`, or `EXHAUSTED`, with reasons and required-check/evidence details. Exit 0 only for `VERIFIED`, 1 for an unmet/failed gate, 2 for invalid configuration or invocation. Without a conversation selector, report workspace verification outcome (VERIFIED, UNVERIFIED, or FAILED), with session exhaustion only in a separate diagnostics array. With a selector, unresolved evidence plus that conversation's exhausted budget yields EXHAUSTED. A different or new conversation does not inherit the budget. Preserve existing commands' exit behavior except documented error corrections. Receipts gain `schemaVersion`, `pluginVersion`, workspace identity, subject digest, and policy digest while retaining existing summary fields.

Freshness covers committed HEAD, staged/unstaged changes, eligible untracked source content, relevant configuration and verification definitions. Hash before and after checks; an edited workspace cannot receive a passing receipt for a different state. Exclude generated evidence/logs to avoid circular invalidation. A commit or policy change invalidates evidence; legacy receipts remain inspectable but cannot satisfy the new versioned gate. For non-Git projects, use a documented filtered source-tree digest and explicitly report that Git review/landing is unavailable.

## Stop behavior

Proposed `stop.mode`: `off` or `remind`, with `stop.maxContinuations` default 1 and permitted range 0–3. Preserve existing opt-in behavior; fresh installs do not silently enable a stop loop. Normalize documented normal completion (`model_stop`) and known legacy completion (`NO_TOOL_CALL`). Treat cancellation, host error, and step limits as termination, never success.

Use status to request bounded continuation on a normal idle stop. Count continuations by conversation and workspace identity, not changing code digest, so edits cannot reset the budget. When exhausted, persist `EXHAUSTED` and let the host terminate; subsequent conversation-specific `status` reports EXHAUSTED, while workspace-only status remains nonzero for its missing or failed evidence. Reset that conversation counter on a fresh VERIFIED result, never on an edit; retain at most the 200 most recently updated conversation records per workspace, deleting oldest records beyond that bound. Successful verification takes precedence over an old exhaustion record. The skill must report incomplete work. Do not claim the host allows an immutable hard-stop barrier: command-hook failures fail open under the documented protocol. A future factory enforces success using CLI exit status.

## Safe integration

Preflight the complete landing operation before changing any target path. Resolve the common base, enumerate adds/modifications/deletions, audit ownership/security, reject target conflicts and symlink escapes, and check applicable source verification. An unchanged target or target identical to the source is safe; divergent committed or uncommitted target changes to a touched path require manual reconciliation. `--force` cannot bypass ownership, path containment, or conflict checks.

Stage file operations with rollback data. Rollback covers only the lander's own writes/deletes, never arbitrary side effects of project verification commands. Before restoring each path compare its content, type and mode to the last state written by the lander. Restore pre-landing bytes/modes only if unchanged; otherwise preserve the newer developer/process edit and return `rollbackConflicts` with recovery locations. Never reset the repository. Use an exclusive per-workspace landing lock to reject concurrent landers; this does not lock out editor or external process edits. Verification commands are trusted and should be observational; disclose their side-effect limitation. Run configured deterministic verification on the integrated workspace. Never transfer worker evidence as coordinator approval. A semantic review of the integrated result remains a mandatory workflow step after landing. VERIFIED means only that configured mechanical requirements passed: review blocks that outcome only when `review` is explicitly included in `verification.requiredEvidence`. Required browser evidence always blocks VERIFIED until satisfied. Report workflow review separately when the policy does not require its attestation. No git commit or push is implicit.

## Packaging and installation

Keep stable ID `antigravity-harness`; proposed display name is `Antigravity Harness` to follow Marketplace branding guidance. Add plugin-local README, license, compatibility notes, supported manifest metadata, and release notes. Retain Node-invoked `bin/` entrypoints: they do not need executable permission. Put any new directly executed helpers under `scripts/`, per official packaging guidance.

Use native `agy plugin install <local-directory>` for host installation. Keep `agy-factory init --mode link|copy` for per-project registration/configuration. Document the difference and avoid double registration. Refuse to overwrite malformed registration JSON; refuse conflicting plugin-local edits during copy updates, remove only previously managed stale files, and keep a recoverable backup. No silent network installation or automatic upgrade.

Produce a versioned archive and SHA-256 file inventory from the canonical bundle; exclude repository tests, example dependencies, `.git`, `.factory`, and secrets. Checksums provide integrity comparison, not publisher authentication. Validate the extracted artifact and exercise it without access to the source checkout. Release automation builds artifacts; publishing a release or submitting to Marketplace is a later explicit action.

Direct GitHub URL installation of this nested bundle requires a disposable native-host experiment. If the host supports the layout, document the verified URL. Otherwise keep clone-and-install as the supported repository route and generate a plugin-root distribution tree for a future release branch/repository. Do not move or duplicate authored source solely to guess at undocumented subdirectory URL syntax.

## Acceptance criteria

1. An extracted bundle validates with `agy plugin validate --strict --json`, discovers the intended components, and runs CLI/hooks outside the source repository with a read-only plugin root.
2. A developer can follow the documented clone/install/setup/verify workflow in a disposable project; native hook activation is observed, not inferred from validation.
3. Required checks/evidence cannot be skipped and still produce VERIFIED. Code, HEAD, or policy changes invalidate earlier results.
4. Stop requests are bounded; exhausting them never produces a success result. Cancellation remains possible.
5. Conflicting or unsafe land operations leave the target unchanged; failed integrated verification restores unchanged lander-owned paths, preserves concurrent edits with explicit rollback conflicts, and reports failure.
6. Existing link/copy and optional Git-hook installation preserve unrelated settings and worktree behavior.
7. A reference full-stack project demonstrates real PostgreSQL integration and browser flows, with artifacts and meaningful failure cases. Dependencies stay in the example, not the plugin.
8. Every change passes `npm test`, `node bin/agy-factory.js verify --require-tests`, and `node bin/agy-factory.js audit-diff`, plus independent read-only diff/security review. Example UI changes require live browser checks.

## Verified research and remaining qualification

On 2026-11-17, local `agy 1.5.9` accepted the existing bundle under strict validation with no findings: 4 skills, 1 rule, 2 hooks. This is loader validation, not proof of live lifecycle behavior or Marketplace approval.

- [Official plugin installation](https://antigravity.google/docs/plugins/): local directories and GitHub URLs are supported; workspace and global installations are documented.
- [Official build/publish guide](https://antigravity.google/docs/build-plugins/): versioned bundles, manifest fields, README, branding, validation, and Marketplace partner intake are documented. Marketplace admission is externally reviewed.
- [Official hooks](https://antigravity.google/docs/hooks/): documented normal Stop payload uses `model_stop`; commands run from plugin root and respond with JSON. The current repository only recognizes `NO_TOOL_CALL`, so compatibility must be tested.

Do not promise a minimum supported Antigravity version until live qualification. Record tested versions in the compatibility guide. Repository installation is available via clone/local-directory even if direct URL layout discovery fails.
