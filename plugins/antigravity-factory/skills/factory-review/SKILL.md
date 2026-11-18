---
name: factory-review
description: >-
  Phase 4B deterministic diff scanning (`agy-factory audit-diff`) and cold-context
  read-only semantic review (`factory-reviewer`), enforcing the Reproduce Before
  Fixing protocol and recording review evidence. Replaces `factory-security-reviewer`.
---

# Factory Review (Phase 4B)

Conduct a two-layer **deterministic + cold-context semantic** audit over the integrated diff.

> **Read-Only Mandate**: While acting as `factory-reviewer`, never edit application source files. Inspect only, emit `APPROVE` or `CHANGES REQUESTED` with `file:line` citations, and hand remediation back to a builder.

## Step 1: Capture Digests & Run Deterministic Diff Audit

```bash
$FACTORY_CLI status --cwd . --json          # capture subjectDigest & policyDigest
$FACTORY_CLI audit-diff --cwd . --json      # or --base main / --allow-paths "<slice>"
```

Check all five deterministic rule families (`slice-boundary-violation`, `hardcoded-secret`, `dangerous-exec`, `sql-interpolation`, `xss-sink`) and manually inspect every `factory-audit-ignore` suppression.

## Step 2: Cold-Context Semantic Review (`factory-reviewer`)

Dispatch a fresh read-only `research` subagent using `../../roles/factory-reviewer.md` (with no builder history or evaluator contamination) to inspect `git status --short`, `git diff`, and untracked files for:
1. **Injection, Validation & Secrets**: Parameterized queries, boundary validation (`400`/`422`), env-only credentials, clean `.env` hygiene.
2. **State & Edge-Case Matrix**: Row locking (`FOR UPDATE`), idempotency keys, UTC/`as_of` temporal correctness, dual-write atomicity, UI `AbortController` + unique `data-testid` attributes.
3. **Documentation Integrity**: Existing comments, docstrings, and types preserved unless invalidated by the diff.

## Step 3: Enforce "Reproduce Before Fixing" on Findings

Whenever `CHANGES REQUESTED` uncovers a bug or regression:
1. Write a standalone failing regression test reproducing the exact defect.
2. Execute the test suite and confirm it fails as expected.
3. Apply the minimal implementation fix in `factory-build`.
4. Re-run `factory-verify` (`agy-factory verify --require-tests` + `/browser`) and re-run `factory-review` on the new candidate digest.

## Step 4: Record Review Outcome

Once inspection finishes on the exact `subjectDigest` / `policyDigest`, record the outcome:

```bash
$FACTORY_CLI evidence record --cwd . \
  --kind review \
  --status PASS \
  --summary "<verdict and key audit notes>" \
  --producer "Cold-context factory-reviewer subagent" \
  --subject-digest <captured-subjectDigest> \
  --policy-digest <captured-policyDigest>
```
