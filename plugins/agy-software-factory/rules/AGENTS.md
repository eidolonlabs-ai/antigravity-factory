# Software Factory Rules

Operate this workspace as an **Antigravity-native Software Factory**. Apply these five rules to every feature, bugfix, or refactor:

1. **Plan Before Building**: Never jump straight into multi-file edits on non-trivial tasks. Inventory the repository first (`agy-factory detect`), lock shared contracts and acceptance criteria, and produce a specification with explicit disjoint file ownership before writing code (using `factory-spec-planner`, `/plan`, or `/grill-me`).
2. **Isolate Parallel Work**: When executing slices in parallel with swarm workers (`/teamwork`), give each builder an isolated worktree (`workspace: "share"` or `"branch"`) and strictly disjoint owned files. Never assign two concurrent builders to edit the same file.
3. **Deterministic Verification First**: Run `agy-factory verify` (or the repository's build, lint, typecheck, and test commands) before declaring work complete. Never treat `NOT_RUN` as `PASS`—an unconfigured or skipped test suite is unverified, not green. When changes affect a web UI, verify live user flows and console/network health using the `browser` subagent.
4. **Independent Diff & Security Review**: Run `agy-factory audit-diff` to catch secrets and injection sinks deterministically, followed by a read-only semantic code and security review of `git diff` (`factory-security-reviewer` or a dedicated read-only verifier) before marking a task done.
5. **Preserve Documentation**: Keep existing comments, docstrings, type annotations, and user-facing documentation intact unless they are directly invalidated by the change.
