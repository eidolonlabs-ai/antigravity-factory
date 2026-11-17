# Antigravity-only template conversion

The approved scope removes other harness installation and hook adapters while keeping the portable Antigravity plugin, CLI, multi-agent workflows, and optional Git verification installer.

## Acceptance and contracts

- `init` defaults to Antigravity; `--target agy` remains valid and other targets fail before filesystem writes.
- Link/copy registration remains self-contained. Existing user configuration remains untouched.
- `--git-hook` explicitly opts into the existing non-destructive Git hook installer, including worktree resolution.
- Hooks accept Antigravity payloads and emit native decisions. Secret, holdout, slice and receipt protections remain covered.
- Documentation and contributor rules describe Antigravity exclusively; its global `.gemini/config/plugins` path remains valid.
- Run `npm test`, `verify --require-tests`, `audit-diff`, then independent semantic/security review.

## Ownership and sequence

One builder owns `lib/init.js`, CLI and hook entrypoints, associated tests, README, contributor rules, package descriptions and affected skills. No parallel builders edit these files. A separate reviewer reads the completed diff only.

Implement init and CLI changes, simplify hook adapters, adapt existing regressions without removing unrelated checks, update documentation, then run gates.
