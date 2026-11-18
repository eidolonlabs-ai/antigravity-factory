# Antigravity Harness plugin

A specialized local harness for solo developers on a single machine. Antigravity supplies native agents, multi-agent swarm delegation, browser operation, and permissions; this plugin adds **Context Engineering** (`rules/AGENTS.md`, slice contracts) and **Harness Engineering** (deterministic `PreToolUse` / `Stop` lifecycle hooks, verification oracles with freshness receipts, holdout test guardrails, `file:line` diff auditing, and conflict-aware `git worktree` integration) alongside multi-stage agent skills.

Requires Node.js 20+ and Git for worktree operations. No plugin runtime dependencies or API keys are required. Application verification may require the application's own dependencies, Docker or browser tooling.

## Install and initialize

From a clone of the source repository, validate then install with the native CLI:

```sh
agy plugin validate ./plugins/antigravity-harness --strict
agy plugin install ./plugins/antigravity-harness
agy plugin list
```

Installation changes your Antigravity profile. Alternatively register a workspace copy using this bundle's CLI: `node <plugin-root>/bin/agy-factory.js init /path/to/project --mode copy`. Link mode is for development and requires the original bundle to remain available. Choose one registration route to avoid loading duplicate rules/hooks. Existing malformed registries or locally modified copies cause an error rather than silent replacement.

Invoke `/factory-pipeline`, `/factory-spec-planner`, `/factory-qa-verifier`, or `/factory-security-reviewer` in Antigravity. Keep small changes in one agent; delegate independent slices only when useful.

## Local delivery

Resolve `<plugin-root>` to this installed bundle. Run `node <plugin-root>/bin/agy-factory.js detect --cwd <project>`, plan shared contracts and ownership, implement, then run `verify --cwd <project> --require-tests` and `audit-diff --cwd <project>`. Use an independent reviewer and native browser checks when needed. Finish with `status --cwd <project> --json`.

`status` exits 0 only when configured requirements are VERIFIED, 1 for unmet requirements, and 2 for invalid configuration. VERIFIED describes configured mechanical requirements; independent semantic review is still a workflow requirement unless its evidence is also required in policy.

Optional `.factory.json` policy:

```json
{
  "schemaVersion": 1,
  "requireTests": true,
  "verification": {
    "requiredChecks": [{"component": ".", "category": "test"}],
    "requiredEvidence": ["review"]
  },
  "stop": {"mode": "remind", "maxContinuations": 1}
}
```

Before browser/review work, capture `subjectDigest` and `policyDigest` from `status --json`. After actually inspecting that state, record evidence with `evidence record --cwd <project> --kind review --status PASS --summary "Review result" --producer "Independent reviewer" --subject-digest <captured> --policy-digest <captured>`. Optional repeated `--artifact <path>` binds existing artifact files. Changed subjects are rejected. Never record evidence for checks that were not performed.

`land --worktree <worker> --allow-paths "src/**" --cwd <project>` requires fresh deterministic verification in the worker, preflights conflicts, then verifies the integrated workspace. Review the combined result afterward. It does not commit or push. Rollback covers lander writes only; concurrent edits are preserved with recovery details. Project test commands can have side effects outside that guarantee.

## Assurance limits

Stop hooks are opt-in bounded reminders, not immutable completion barriers. Budget exhaustion remains nonpassing in conversation-specific status. Hook execution errors can fail open in Antigravity. Protected holdout files are guarded against selected write paths, not hidden from agents. Local SHA-256 receipts are freshness evidence, not signed security attestations. Regex audits supplement independent review. No scheduler, daemon, remote fleet, or cross-platform adapters are included.

Loader tested with Antigravity CLI 1.5.9. Live authenticated lifecycle behavior and direct GitHub URL discovery for the nested repository layout remain unqualified. Marketplace admission is separate from producing a valid bundle.
