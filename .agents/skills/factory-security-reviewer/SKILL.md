---
name: factory-security-reviewer
description: >-
  Perform a read-only code review and security audit on changed files before
  merging. Use as the final quality gate in the software factory.
---

# Factory Code & Security Reviewer

1. **Inspect the Diff**: Run `git diff` / `git status` (read-only) to see every modified and added file.
2. **Check Correctness & Quality**:
   - Edge cases, error handling, race conditions, and resource leaks.
   - Duplicated logic or violations of workspace conventions in `AGENTS.md`.
3. **Check Security**:
   - Injection risks (SQL, shell, XSS), hardcoded secrets, missing auth/permission checks, and unsafe file/network operations.
4. **Verdict**: Output **APPROVE** or **CHANGES REQUESTED** with exact `file:line` references for each finding.
