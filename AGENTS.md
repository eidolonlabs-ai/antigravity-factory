# Software Factory Workspace & Contributor Rules

This repository develops and ships **Antigravity Software Factory** (`agy-software-factory`), a portable plugin, deterministic Node.js CLI, and multi-agent workflow suite supporting **Antigravity**, **Claude Code**, **Gemini CLI**, and **OpenAI Codex**. Follow both the five Software Factory rules and the repository contributor constraints below on every change.

## Software Factory Rules

1. **Plan Before Building**: Never jump straight into multi-file edits for non-trivial tasks. Inventory the repository (`node bin/agy-factory.js detect`) and produce a clear spec with acceptance criteria, shared contracts, and explicit disjoint file ownership first (via `factory-spec-planner`, `.factory/spec.json` with `node bin/agy-factory.js plan`, or `/plan` / `/grill-me`).
2. **Isolate Parallel Work**: When multiple builders work in parallel, assign each worker disjoint files or modules in an isolated git worktree (via Antigravity `/teamwork` with `workspace: "share"` / `"branch"`, or `git worktree add` + `FACTORY_SLICE=<slice>` in Claude Code, Gemini CLI, and Codex). Verify slice boundaries with `node bin/agy-factory.js audit-diff --slice <slice>` (or `--allow-paths "<slice-globs>"`) and land changes via `node bin/agy-factory.js land --worktree <dir> --slice <slice>`. Never assign two builders to the same file.
3. **Deterministic Verification First**: Every change must pass deterministic verification (`npm test` and `node bin/agy-factory.js verify --require-tests`), never treating `NOT_RUN` as `PASS` or tampering with `.factory/verify-receipt.json` / `holdout/` tests—plus live UI checks via the `browser` subagent (or Playwright/headless E2E browser checks in terminal agents) when touching `examples/task-tracker/web/`.
4. **Independent Diff & Security Review**: Always run `node bin/agy-factory.js audit-diff` and perform an independent read-only semantic code & security review on `git diff` (`factory-security-reviewer` or a dedicated read-only reviewer subagent) before considering a task complete.
5. **Preserve Documentation**: Keep existing comments, docstrings, and CLI/plugin documentation intact unless directly invalidated by the change.

## Repository Contributor Constraints

- **Zero External Runtime Dependencies in the Factory Plugin**: Everything inside `plugins/agy-software-factory/` (`bin/` and `lib/`) and `bin/agy-factory.js` must use **only** Node.js 20+ built-in ESM modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:util`, `node:os`). Do not add third-party npm packages inside `plugins/agy-software-factory/`. *(Note: If you created a new application repository from this GitHub template, you are free to add application dependencies to your app directories or root `package.json` as needed.)*
- **Self-Contained Plugin Bundle**: `plugins/agy-software-factory/` must operate cleanly when linked or copied into another repository (`agy-factory init --mode link|copy`) or installed under `~/.gemini/config/plugins/agy-software-factory`. Lifecycle hooks in `plugins/agy-software-factory/bin/` must remain self-contained and fail safe.
- **Antigravity Spec Compliance**: Keep `plugins/agy-software-factory/plugin.json` restricted to documented manifest keys, keep `plugins/agy-software-factory/rules/AGENTS.md` plain Markdown with no YAML frontmatter, and include `name` and `description` frontmatter on every `SKILL.md`.
- **Pre-Completion Gate**: Before finishing any change to this repository, run:
  ```bash
  npm test
  node bin/agy-factory.js audit-diff
  ```
