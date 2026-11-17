---
name: factory-security-reviewer
description: >-
  Runs deterministic diff scanning with `agy-factory audit-diff` to catch
  secrets, SQL interpolation, dynamic code execution, and XSS sinks with
  `file:line` precision, followed by an independent read-only semantic review of
  `git diff`. Use this skill as the final review gate before declaring work done.
---

# Factory Security & Diff Reviewer

Perform a two-layer **deterministic + semantic** code and security audit over workspace changes.

> **Read-Only Mandate**: While acting as reviewer, do **not** modify application source files. Inspect only, then return `APPROVE` or `CHANGES REQUESTED` with exact `file:line` citations.

## Step 1: Run Deterministic Diff Audit (`agy-factory audit-diff`)

Run `agy-factory audit-diff` first to scan all modified and untracked files (or diff against a base ref):

```bash
node ./bin/agy-factory.js audit-diff --cwd . --json
# Enforce slice file ownership boundaries for a worker or slice:
# node ./bin/agy-factory.js audit-diff --cwd . --allow-paths "api/**,db/init.sql" --json
# Compare against a specific git ref:
# node ./bin/agy-factory.js audit-diff --cwd . --base main --json
# Audit every non-ignored file in the workspace:
# node ./bin/agy-factory.js audit-diff --cwd . --all --json
```

*(From external repos, invoke `npx agy-factory audit-diff ...` or `node <plugin-dir>/bin/agy-factory.js audit-diff ...`.)*

### Built-In Deterministic Rules

`agy-factory audit-diff` flags exact `file:line` matches across five rule families:
- **`slice-boundary-violation`** (`high`): Modified or untracked files outside `--allow-paths <list>` (when enforcing disjoint slice ownership).
- **`hardcoded-secret`** (`high`): Cloud access keys, PEM private key headers, and hardcoded API keys, tokens, secrets, or passwords.
- **`dangerous-exec`** (`high`): Dynamic code execution via `eval` or the `Function` constructor.
- **`sql-interpolation`** (`high`): Unparameterized template-literal value interpolation inside SQL statements.
- **`xss-sink`** (`medium`): Unsafe raw HTML injection properties or direct DOM `innerHTML` assignments.

### Interpreting `audit-diff` Statuses

- **`FLAGGED`** (exit code `1`): One or more `high`-severity findings detected. Automatic `CHANGES REQUESTED` unless proven to be a benign test fixture.
- **`WARN`** (exit code `0`): `medium`-severity findings present. Inspect each `file:line` to verify safe sanitization or request remediation.
- **`APPROVE_CANDIDATE`** (exit code `0`): Zero deterministic findings—proceed to Step 2 semantic review.
- **Suppression Audit**: Any line carrying `factory-audit-ignore` skips the regex scanner; always inspect suppressed lines manually during Step 2 to ensure suppressions are restricted to legitimate unit test fixtures.

## Step 2: Independent Read-Only Semantic Review

Deterministic regexes catch known sinks; semantic review catches logic, boundary, and architectural flaws. Run `git status --short` and `git diff` (plus read new untracked files) and verify:

1. **Injection & Query Safety**: Every SQL/ORM/shell call uses parameterized placeholders (`$1..$N`) or strict identifier allowlists—never user-controlled string concatenation.
2. **Input Validation & Error Handling**: Route params, IDs, booleans, and string lengths are validated at trust boundaries; malformed JSON returns `400`; `500` responses log internally without leaking stack traces or connection strings.
3. **Auth, CORS & Secret Hygiene**: Credentials come exclusively from environment variables; `.env` is ignored by `.gitignore` and untracked; `.env.example` holds non-sensitive local defaults only.
4. **Correctness, Concurrency & Resource Cleanup**: Async errors are awaited/caught, effect hooks clean up inflight requests on unmount, edge cases (`404`, empty states) behave cleanly, and existing comments/docstrings remain intact.

## Step 3: Emit Final Review Verdict

Conclude with an explicit verdict block:

- **Verdict**: `APPROVE` or `CHANGES REQUESTED`
- **Deterministic Scan**: `status` (`APPROVE_CANDIDATE` | `WARN` | `FLAGGED`), `filesScanned`, and finding count
- **Semantic Audit Summary**: Brief verification notes across SQL/injection, XSS, secrets/config, and correctness/error handling with `file:line` references
- **Required Fixes** *(only when `CHANGES REQUESTED`)*: Numbered list of blocking `file:line` issues and exact remediation steps (note that any subsequent code edit must re-run `agy-factory verify` before re-review)

## Record the independent review outcome

Before inspecting the diff, run `status --json` and retain its subject and policy digests. Keep application source read-only. After review, the coordinator may record the actual result via `evidence record --kind review --status PASS|FAIL --summary <review-summary> --producer <reviewer-description> --subject-digest <captured> --policy-digest <captured>`. This controlled metadata write is not permission to edit code or forge an attestation. Any source change requires fresh review. Caller-supplied producer text is attribution, not proof of independence. Finish with configured status plus a separate semantic-review verdict.
