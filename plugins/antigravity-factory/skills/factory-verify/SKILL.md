---
name: factory-verify
description: >-
  Phase 4A deterministic QA and live browser verification (`agy-factory verify`,
  Docker Compose stack health, `browser` subagent E2E flows, and `evidence record`).
  Enforces `NOT_RUN !== PASS`. Replaces `factory-qa-verifier`.
---

# Factory Verify (Phase 4A)

Prove the integrated workspace builds, passes real tests against the live stack, maintains secret/git hygiene, and works end-to-end in the browser.

## Step 1: Capture Pre-Inspection Digests

Before running live checks or recording browser evidence, capture the current candidate digests:

```bash
$FACTORY_CLI status --cwd . --json
```

Save `subjectDigest` and `policyDigest` (a nonzero exit code is normal before all configured gates pass).

## Step 2: Run Deterministic Verification (`NOT_RUN !== PASS`)

```bash
$FACTORY_CLI verify --cwd . --require-tests --json
```

Audit every check in the output and in `.factory/verify-receipt.json`:
- **`FAIL`**: Immediate blocker. Inspect the failing command and tail logs (`/tmp/*.log`), fix at the root cause, and re-run.
- **`NOT_RUN` Is Never `PASS`**: Missing scripts or skipped test suites fail verification under `--require-tests`. Only pass `--skip-docker` when Docker is intentionally unavailable in the environment, and report Compose checks as `NOT_RUN`.
- **Receipt Freshness**: Any source, index, HEAD, or `.factory.json` edit invalidates `.factory/verify-receipt.json`.

## Step 3: Live Stack & `/browser` E2E Verification

Whenever the project includes a web UI or multi-service stack:
1. Boot the real Docker Compose stack (`docker compose up --build -d > /tmp/compose.log 2>&1`) and wait for service health checks—never substitute mocked databases for real-stack checks.
2. Invoke the `browser` subagent (`/browser`) against the live UI URL to test:
   - Initial render and seeded/loading states.
   - Core CRUD/mutation flows, edge cases, and persistence across reload.
   - Zero uncaught console errors and zero unexpected failed network requests.
3. Tear down ephemeral verification stacks (`docker compose down`) unless the owner asked to keep a preview running.

## Step 4: Record Observed Browser Evidence

After actually executing live browser checks on the exact candidate, record the outcome:

```bash
$FACTORY_CLI evidence record --cwd . \
  --kind browser \
  --status PASS \
  --summary "<flows verified and console/network health>" \
  --producer "Antigravity browser subagent" \
  --subject-digest <captured-subjectDigest> \
  --policy-digest <captured-policyDigest>
```

Never fabricate evidence or record `PASS` for checks that were not executed.
