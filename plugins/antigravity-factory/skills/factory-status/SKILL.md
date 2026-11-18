---
name: factory-status
description: >-
  Inspect Antigravity Factory run readiness, `.factory/verify-receipt.json`
  freshness, required component checks, browser/review evidence digests, and
  conversation stop-gate state via `agy-factory status --json`.
---

# Factory Status & Delivery Report

Inspect deterministic factory status and present a truthful handoff report to the owner.

## Step 1: Query Read-Only Factory Status

```bash
$FACTORY_CLI status --cwd . --json
# Include conversation ID when auditing Stop-hook continuation state:
# $FACTORY_CLI status --cwd . --conversation <id> --json
```

Exit codes:
- `0`: `VERIFIED` (all configured required checks and required evidence match the current `subjectDigest` and `policyDigest`).
- `1`: `UNVERIFIED`, `FAILED`, or `EXHAUSTED` (missing/stale verification receipt, failing checks, missing evidence, or stop-hook budget exhaustion).
- `2`: Invalid configuration (`.factory.json`) or CLI invocation.

## Step 2: Present Separate Mechanical & Semantic Status

Always report these sections separately without conflating them:
1. **Mechanical Status**: `status` (`VERIFIED` / `UNVERIFIED` / `FAILED` / `EXHAUSTED`), `subjectDigest`, `policyDigest`, and per-check `PASS` / `FAIL` / `NOT_RUN` breakdown from `.factory/verify-receipt.json`.
2. **Live UI / Browser Coverage**: Recorded `browser` evidence or explicit gaps (if no live browser pass ran).
3. **Independent Review**: Recorded `review` evidence, deterministic `audit-diff` status, and any remaining warnings or open risks.
4. **Next Owner Action**: Explicit recommendation (e.g., review diff and commit/merge, or resolve remaining failing/unverified checks). Never describe stop-hook budget exhaustion as completion.
