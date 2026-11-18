# Antigravity Factory contributor rules

This repository develops and ships **Antigravity Factory** (plugin ID `antigravity-factory`), a portable plugin, deterministic Node.js CLI, and multi-agent workflow suite for **Antigravity**. Follow both the five Antigravity Factory rules and the repository contributor constraints below on every change.

## Antigravity Factory Rules

1. **Plan Before Building (Shift-Left Pushback)**: Never jump straight into multi-file edits for non-trivial tasks. Route the request via `factory-intake`—actively pushing back (`needs_clarification`) if requirements are incomplete across the entry-point checks or the 4-Part State & Edge-Case Matrix (using `/grill-me` and read-only `factory-architect`). Inventory the repository (`node bin/agy-factory.js detect`) and freeze contracts, Milestone 1.5 tests, and explicit disjoint slice ownership (`factory-plan`, `.factory/spec.json` via `node bin/agy-factory.js plan`, or `/plan`) before implementation starts.
2. **Isolate Parallel Work**: When multiple builders work in parallel (`factory-build`), assign each worker (`factory-builder`) disjoint files or modules in an isolated git worktree (via Antigravity `swarm` / `/teamwork` with `workspace: "share"` / `"branch"`, or `git worktree add` + `FACTORY_SLICE=<slice>`). Verify slice boundaries with `node bin/agy-factory.js audit-diff --slice <slice>` (or `--allow-paths "<slice-globs>"`) and land changes via `node bin/agy-factory.js land --worktree <dir> --slice <slice>`. Never assign two builders to the same file.
3. **Deterministic Verification First**: Every change must pass deterministic verification (`factory-verify`: `npm test` and `node bin/agy-factory.js verify --require-tests`), never treating `NOT_RUN` as `PASS` or tampering with `.factory/verify-receipt.json` / `holdout/` tests—plus live UI checks via the `browser` subagent (or Playwright/headless E2E browser checks in terminal agents) when touching `examples/task-tracker/web/`.
4. **Independent Diff & Security Review**: Always run `node bin/agy-factory.js audit-diff` and perform an independent read-only semantic code & security review on `git diff` (`factory-review` / `factory-reviewer` or a dedicated read-only reviewer subagent, enforcing **Reproduce Before Fixing**) before concluding with `factory-status`.
5. **Preserve Documentation**: Keep existing comments, docstrings, and CLI/plugin documentation intact unless directly invalidated by the change.

## Repository Contributor Constraints

- **Zero External Runtime Dependencies in the Factory Plugin**: Everything inside `plugins/antigravity-factory/` (`bin/` and `lib/`) and `bin/agy-factory.js` must use **only** Node.js 20+ built-in ESM modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:http`, `node:util`, `node:os`, `node:url`). Do not add third-party npm packages inside `plugins/antigravity-factory/`. *(Note: If you created a new application repository from this GitHub template, you are free to add application dependencies to your app directories or root `package.json` as needed.)*
- **Self-Contained Plugin Bundle**: `plugins/antigravity-factory/` must operate cleanly when linked or copied into another repository (`agy-factory init --mode link|copy`) or installed under `~/.gemini/config/plugins/antigravity-factory`. Lifecycle hooks in `plugins/antigravity-factory/bin/` must remain self-contained and fail safe.
- **Antigravity & Non-Destructive `init`**: Preserve native hook payloads and decisions, existing plugin registrations and optional pre-commit hooks, and `.git` file (`gitdir:` / `commondir`) resolution for worktrees/submodules. Keep instructions focused on Antigravity.
- **Portable Minimal-`PATH` Test Isolation**: Tests that construct a restricted `PATH` (e.g., to hide optional tools like `docker`) must never assume `npm` or `git` resides in `path.dirname(process.execPath)`. Resolve companion binaries across `[path.dirname(process.execPath), ...PATH]` (with `process.env.npm_execpath` wrapper fallback) and fail loudly if absent.
- **Antigravity Spec Compliance**: Keep `plugins/antigravity-factory/plugin.json` restricted to documented manifest keys, keep `plugins/antigravity-factory/rules/AGENTS.md` plain Markdown with no YAML frontmatter, and include `name` and `description` frontmatter on every `SKILL.md`.
- **Pre-Completion Gate**: Before finishing any change to this repository, run:
  ```bash
  npm test
  node bin/agy-factory.js audit-diff
  ```
