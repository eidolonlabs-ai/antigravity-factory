# Software Factory Workspace Rules

This workspace operates as an **Antigravity-native Software Factory**. Follow these rules for every build, feature, or refactor:

1. **Plan Before Building**: Never jump straight into multi-file edits for non-trivial tasks. Produce a clear spec with explicit file ownership first (or use `/plan` / `/grill-me`).
2. **Isolate Parallel Work**: When multiple builders work in parallel via `/teamwork` (swarm), assign each worker disjoint files or modules and give each author `workspace: "share"` (or `"branch"`). Never assign two builders to the same file.
3. **Verify Before Declaring Done**: Every change must pass the project's build, linter, and test suite—plus live UI checks via the `browser` subagent when applicable.
4. **Independent Review**: Always run a read-only code & security review pass on the final diff before considering a task complete.
5. **Preserve Documentation**: Keep existing comments and docstrings intact unless they are directly invalidated by the change.
