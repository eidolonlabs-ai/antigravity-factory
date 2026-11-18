---
name: factory-qa-verifier
description: >-
  Runs deterministic verification via `agy-factory verify`, audits `PASS`,
  `FAIL`, and `NOT_RUN` check states and `.factory/verify-receipt.json`, and
  runs live E2E web checks via the `browser` subagent or automated E2E runners.
  Use this skill to verify builds, tests, workspace hygiene, and UI flows before
  completion.
---

# Harness QA Verifier

Prove that workspace changes build, pass real tests, satisfy secret/git hygiene, and work end-to-end in a live browser when a web UI is present.

## Step 1: Run Deterministic CLI Verification

Execute `agy-factory verify` against the target workspace with `--require-tests` whenever automated tests are expected:

```bash
node ./bin/agy-factory.js verify --cwd . --require-tests
# Machine-readable output:
# node ./bin/agy-factory.js verify --cwd . --require-tests --json
# Skip Docker Compose config check only when Docker CLI is unavailable:
# node ./bin/agy-factory.js verify --cwd . --require-tests --skip-docker
```

*(If running from an external repository where the plugin is installed, invoke `npx agy-factory verify ...` or `node <plugin-dir>/bin/agy-factory.js verify ...`.)*

## Step 2: Inspect `PASS` / `FAIL` / `NOT_RUN` States & Receipt

Review every check reported by `agy-factory verify` (`hygiene`, `docker-compose`, and per-component `lint`, `typecheck`, `test`, `build`):

1. **`FAIL`**: Immediate blocker. Capture the exact `command` and `output` from the failing check and fail verification.
2. **`NOT_RUN` Is Never `PASS`**:
   - `NOT_RUN` means no script/tool was configured (or Docker CLI is not installed / `--skip-docker` was set)—it does **not** mean the check succeeded. Docker Compose validation is optional when `docker` is unavailable, reporting `NOT_RUN` without failing the build.
   - Never report "all checks passed" if `test` is `NOT_RUN`. With `--require-tests` (or `"requireTests": true` in `.factory.json`), `agy-factory verify` enforces that at least one component `test` check achieves `PASS`, setting `ok: false` and exiting non-zero otherwise.
3. **Validate `.factory/verify-receipt.json` & Local Guardrails**:
   - Read `<cwd>/.factory/verify-receipt.json` and confirm `"ok": true`.
   - Note that `.factory/**` (receipt integrity) and `holdout/**` / `*.holdout.test.*` (holdout test suites) are protected by `pre-tool-guard.js` against direct agent edits or shell tampering.
   - The receipt binds HEAD, staged index, working source content/modes, symlink target text and policy with SHA-256 freshness values; it is not signed. Any subsequent source, commit, index or policy change invalidates the receipt and requires re-running `agy-factory verify` (which also satisfies the `Stop` verification gate hook when enabled).

## Step 3: Live Web UI Verification (`browser` Subagent or E2E Browser Runner)

Whenever the repository or diff includes a web frontend (`web/`, React/Vite/Next, HTML/CSS, or Nginx proxy):

1. **Boot the stack**: Start the application locally (e.g., `docker compose up --build -d` or component dev servers) and verify backend/frontend readiness (`curl -fsS http://localhost:<port>/health`).
2. **Exercise live E2E user flows**: Invoke the `browser` subagent (in Antigravity) against the live URL to test:
   - Initial render and data loading state.
   - Core mutations (creating, toggling/updating, filtering, and deleting items).
   - Persistence across page reload (when backed by an API/DB).
   - Browser console errors and failed HTTP network requests (must be zero).
3. **Clean up ephemeral services**: Stop temporary background servers or containers (`docker compose down`) once verification finishes, unless the user asked to keep them running.

## Step 4: Emit Structured QA Report

Output a concise QA summary containing:
- **Verdict**: `QA PASS` or `QA FAIL`
- **Receipt Status**: `.factory/verify-receipt.json` (`ok`, `digest`, `summary: { pass, fail, notRun }`)
- **Check Breakdown**: Per-component `PASS` / `FAIL` / `NOT_RUN` table
- **Browser E2E Coverage**: Flows exercised and console/network health (or `N/A — no web UI`)
- **Actionable Failures** *(if `QA FAIL`)*: Exact reproduction commands and failure logs

## Record observed browser evidence

Before live checks, run `status --json` and retain its `subjectDigest` and `policyDigest` (nonzero status is expected before requirements are satisfied). After actually exercising the flows, use `evidence record --kind browser --status PASS|FAIL --summary <observed-result> --producer <browser-runner> --subject-digest <captured> --policy-digest <captured>` with existing artifacts when available. A changed subject requires repeating the checks. Explicitly configured browser commands can supply this evidence through a fresh passing receipt. Never write internal records directly or report NOT_RUN as PASS. Finish with status; stopping is not proof of verification.
