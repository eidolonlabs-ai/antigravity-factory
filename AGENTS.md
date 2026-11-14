# Software Factory Workspace & Contributor Rules

This repository develops and ships **Antigravity Software Factory** (`agy-software-factory`), a portable plugin, CLI, and multi-agent workflow suite. Follow both the five Software Factory rules and the repository contributor constraints below on every change.

## Software Factory Rules

1. **Plan Before Building**: Never jump straight into multi-file edits for non-trivial tasks. Produce a clear spec with acceptance criteria, shared contracts, and explicit disjoint file ownership first (via `factory-spec-planner`, `/plan`, or `/grill-me`).
2. **Isolate Parallel Work**: When multiple builders work in parallel via `/teamwork` (swarm), assign each worker disjoint files or modules and give each author `workspace: "share"` (or `"branch"`). Never assign two builders to the same file.
3. **Deterministic Verification First**: Every change must pass deterministic verification (`npm test` and `node bin/agy-factory.js verify --require-tests`), never treating `NOT_RUN` as `PASS`—plus live UI checks via the `browser` subagent when touching `examples/task-tracker/web/`.
4. **Independent Diff & Security Review**: Always run `node bin/agy-factory.js audit-diff` and perform an independent read-only semantic code & security review on `git diff` before considering a task complete.
5. **Preserve Documentation**: Keep existing comments, docstrings, and CLI/plugin documentation intact unless directly invalidated by the change.

## Repository Contributor Constraints

- **Zero External Runtime Dependencies**: Everything inside `plugins/agy-software-factory/` (`bin/` and `lib/`) must use **only** Node.js 20+ built-in ESM modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:util`, `node:os`). Do not add third-party npm packages to the plugin or root `package.json`.
- **Self-Contained Plugin Bundle**: `plugins/agy-software-factory/` must operate cleanly when linked or copied into another repository (`agy-factory init --mode link|copy`) or installed under `~/.gemini/config/plugins/agy-software-factory`. Lifecycle hooks in `plugins/agy-software-factory/bin/` must remain self-contained and fail safe.
- **Antigravity Spec Compliance**: Keep `plugins/agy-software-factory/plugin.json` restricted to documented manifest keys, keep `plugins/agy-software-factory/rules/AGENTS.md` plain Markdown with no YAML frontmatter, and include `name` and `description` frontmatter on every `SKILL.md`.
- **Pre-Completion Gate**: Before finishing any change to this repository, run:
  ```bash
  npm test
  node bin/agy-factory.js audit-diff
  ```
