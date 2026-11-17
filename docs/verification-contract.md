# Verification and evidence contract

The plugin supplies mechanical checks; Antigravity supplies agents and browser operation. Independent review is required by workflow. `VERIFIED` means the configured mechanical requirements passed, not that every possible quality property was proven.

## Configuration

`.factory.json` accepts `schemaVersion: 1`, legacy `requireTests` and `enforceStopVerify`, and optional `verification` and `stop` objects. Malformed or unsupported configuration fails instead of weakening policy. Existing installations keep legacy defaults; new initialization requires at least one passing test and leaves stop reminders off.

`verification.requiredChecks` is an array of `{component, category}`. Component is its workspace-relative path (`.` for root); category is `lint`, `typecheck`, `test` or `build`. Every selected check must PASS. Missing and skipped checks fail policy. Legacy `requireTests` only requires at least one passing component test.

`verification.commands` entries have unique lowercase `id`, trusted project `command`, workspace-contained `cwd` (default `.`), and `timeoutMs` (default 120000, range 1000–1800000). Every command is required. `providesEvidence: "browser"` explicitly maps a passing command to browser evidence. These commands execute local project code and can have side effects; this is not an OS sandbox.

`verification.requiredEvidence` contains `browser` and/or `review`, default empty. `verification.artifactRoots` optionally allows existing absolute directories in addition to the workspace for referenced artifact files.

`stop` accepts `mode: "off"|"remind"` and `maxContinuations: 0..3` (default 1). Legacy activation and `FACTORY_ENFORCE_STOP=1` remain supported. Budgets are per workspace/conversation and do not reset on edits. The hook clears its conversation state after observing VERIFIED and retains at most 200 recently updated sessions. Cancellation and host errors may terminate; exhaustion is never success.

## Commands and exit codes

- `verify`: writes `.factory/verify-receipt.json`; 0 for passing deterministic verification, 1 otherwise. Required browser/review evidence is aggregated separately by `status`.
- `status --json [--conversation <id>]`: read-only; 0 VERIFIED, 1 UNVERIFIED/FAILED/EXHAUSTED, 2 invalid invocation/configuration. Without a conversation ID, exhaustion is diagnostic and does not poison other conversations.
- `evidence record --kind browser|review --status PASS|FAIL --summary <text> --producer <text> --subject-digest <digest> --policy-digest <digest> [--artifact <path>]`: 0 on successful recording, 2 invalid/stale input. All commands accept `--cwd`.

Capture both digests from `status --json` BEFORE performing a review or browser operation. Record the actual result afterward. Changes during inspection invalidate recording; rerun the inspection. Referenced artifacts are hashed and checked again at status time. Producer identity is declared by the caller and does not authenticate reviewer independence. Do not invent evidence.

## Freshness and scope

Version-1 receipts include plugin version, workspace identity, subject digest, policy digest, timestamp, check results and summary. Legacy receipts remain readable but cannot satisfy the new status gate. Digests are SHA-256 integrity/freshness values, not signatures.

Git subjects bind HEAD, index entries including blob identity/mode, and current tracked/untracked non-ignored source file bytes and modes. Symlinks bind their target text, not external source contents reached through them; verify external dependencies separately. Git inspection errors fail rather than produce an empty digest. Submodule entries require separate verification. Non-Git subjects hash a filtered source tree excluding `.git`, `.factory`, `node_modules`, `dist`, `build`, `coverage`, and `__pycache__`. Generated logs/evidence belong under `.factory/`. Policy and slice spec contents are also bound. Pre/post hashes reject source changes during verification.

Local evidence assumes trusted project commands and a cooperative agent under the user's account. Hooks protect selected tool operations; they cannot prevent every arbitrary process from tampering with local files. Holdouts are write-protected through supported tool paths, not sealed.

## Landing and recovery

Verify a worker before landing. `land` preflights the entire touched-path set, rejecting ownership violations, divergent target changes, staged edits and symlink paths. `--force` only overrides regex security findings; it cannot bypass ownership, conflicts or required worker verification. An exclusive `.factory/land.lock` rejects concurrent landers.

Integrated deterministic verification runs after applying changes. The combined result needs independent review. Required review evidence is a mechanical completion gate only when configured. Landing never commits or pushes.

On failure, compare-before-restore rollback covers only the lander's writes/deletes. A newer edit is preserved and listed in `rollbackConflicts`, with a recovery JSON path holding original bytes/modes. Arbitrary verification-command side effects are outside this guarantee. Do not delete a lock until its process has stopped and its recovery state has been inspected. Dry-run performs no application writes and reports missing worker verification.
